/// Vast.ai backend: rent one GPU instance for one proof and give it back.
///
/// Per job: search offers under the config caps → create an instance from the Moongate GPU prover
/// image (its onstart starts moongate-server) → wait for ssh → copy the cuda prover binary and the
/// payload in → run `blindseal-prover --mode cuda` against the server on localhost → copy the
/// attestation back → destroy the instance. The instance is destroyed whatever happens: on success,
/// on any error, when `signal` aborts, when the watchdog (`maxInstanceAgeMinutes`) fires, and on
/// process exit (a synchronous best-effort destroy from the exit hooks). Never leave one running: a
/// forgotten instance bills by the hour.
///
/// The Vast CLI (`vastai`) is driven through child_process with `--raw` JSON output; the API key is
/// read from `apiKeyFile` into the child's VAST_API_KEY only (never an argument, never logged). The
/// driver is an interface so tests run the whole flow against a fake.
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { proverArgs, shq } from './prover-args.js';
import type { AttestationJson, ProofBackend, ProofJob } from './types.js';

export interface VastConfig {
  /// file holding the Vast API key, one line
  apiKeyFile: string;
  /// Vast gpu_name, e.g. RTX_4090
  gpu: string;
  maxPriceUsdPerHour: number;
  /// the watchdog: the instance is destroyed this many minutes after creation even if the proof is still running
  maxInstanceAgeMinutes: number;
  /// docker image for the instance: the Moongate GPU prover image sp1-cuda expects (its entrypoint is moongate-server)
  image: string;
  diskGb: number;
  /// the prover built with --features cuda,native-gnark for linux-x64, copied onto the instance
  proverBinary: string;
  /// offer filters beyond price/gpu (defaults: >= 32 GB RAM, reliability >= 0.98, on-demand)
  minRamGb?: number;
  minReliability?: number;
  /// how long to wait for ssh after creation (default 10 min)
  sshTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface VastOffer { id: number; dph_total: number; gpu_name: string; cpu_ram: number; disk_space: number; reliability2?: number; reliability?: number }
export interface VastInstance { id: number; actual_status?: string; ssh_host?: string; ssh_port?: number; dph_total?: number; gpu_name?: string }
export interface RemoteResult { code: number | null; stdout: string; stderr: string }

/// What the backend needs from Vast and from the instance. `cliDriver` is the real one.
export interface VastDriver {
  searchOffers(query: string, order: string): Promise<VastOffer[]>;
  createInstance(offerId: number, opts: { image: string; diskGb: number; onstart: string; label: string }): Promise<number>;
  showInstance(id: number): Promise<VastInstance | undefined>;
  destroyInstance(id: number): Promise<void>;
  /// synchronous destroy for process-exit hooks (no await possible there)
  destroyInstanceSync(id: number): void;
  ssh(inst: VastInstance, command: string, signal?: AbortSignal): Promise<RemoteResult>;
  scpTo(inst: VastInstance, local: string, remote: string): Promise<void>;
  scpFrom(inst: VastInstance, remote: string, local: string): Promise<void>;
}

/// Instances this process created and has not destroyed yet, destroyed from the exit hooks.
const LIVE = new Map<number, VastDriver>();
let hooksInstalled = false;
function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const sweep = () => { for (const [id, d] of LIVE) { try { d.destroyInstanceSync(id); } catch { /* best effort */ } LIVE.delete(id); } };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { sweep(); process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1)); });
  }
}
/// For tests: the ids the exit hooks would destroy.
export function liveInstances(): number[] { return [...LIVE.keys()]; }

export function offerQuery(cfg: VastConfig): string {
  const ram = cfg.minRamGb ?? 32;
  const rel = cfg.minReliability ?? 0.98;
  return `gpu_name=${cfg.gpu} num_gpus=1 rentable=true rented=false cpu_ram>=${ram} disk_space>=${cfg.diskGb} reliability>=${rel} dph<=${cfg.maxPriceUsdPerHour}`;
}

/// moongate-server listens on 3000 inside the instance; the onstart script keeps it running in the background.
export const ONSTART = 'nohup moongate-server > /var/log/moongate.log 2>&1 &';
const REMOTE_DIR = '/work';
const MOONGATE_URL = 'http://127.0.0.1:3000';

export class VastBackend implements ProofBackend {
  readonly name = 'vast' as const;
  constructor(private readonly cfg: VastConfig, private readonly driver: VastDriver = cliDriver(cfg)) {}

  async prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson> {
    const log = this.cfg.log ?? (() => {});
    if (signal.aborted) throw new Error('vast: aborted before an instance was created');
    const offers = (await this.driver.searchOffers(offerQuery(this.cfg), 'dph_total')).filter((o) => o.dph_total <= this.cfg.maxPriceUsdPerHour);
    const offer = offers.sort((a, b) => a.dph_total - b.dph_total)[0];
    if (!offer) throw new Error(`vast: no ${this.cfg.gpu} offer under ${this.cfg.maxPriceUsdPerHour} USD/h matches ${offerQuery(this.cfg)}`);
    log(`vast: offer ${offer.id} ${offer.gpu_name} at ${offer.dph_total.toFixed(3)} USD/h`);

    installExitHooks();
    const id = await this.driver.createInstance(offer.id, { image: this.cfg.image, diskGb: this.cfg.diskGb, onstart: ONSTART, label: `blindseal-${job.id}` });
    LIVE.set(id, this.driver);
    log(`vast: instance ${id} created (watchdog ${this.cfg.maxInstanceAgeMinutes} min)`);

    let destroyed: Promise<void> | undefined;
    const destroy = (why: string): Promise<void> => {
      if (!destroyed) {
        destroyed = this.driver.destroyInstance(id).then(() => { LIVE.delete(id); log(`vast: instance ${id} destroyed (${why})`); }, (e) => {
          // keep it in LIVE so the exit hook tries once more
          log(`vast: destroying instance ${id} failed (${why}): ${(e as Error).message}; the exit hook will retry — check \`vastai show instances\``);
          throw e;
        });
      }
      return destroyed;
    };
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => { ctrl.abort(new Error(`vast: watchdog: instance ${id} older than ${this.cfg.maxInstanceAgeMinutes} min`)); }, this.cfg.maxInstanceAgeMinutes * 60_000);
    const onAbort = () => ctrl.abort(signal.reason ?? new Error('vast: aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    // the watchdog and the caller's abort both destroy right away, not after the step in flight finishes
    ctrl.signal.addEventListener('abort', () => { void destroy(String((ctrl.signal.reason as Error)?.message ?? 'abort')).catch(() => {}); }, { once: true });

    try {
      const inst = await this.waitForSsh(id, ctrl.signal);
      log(`vast: instance ${id} reachable over ssh (${inst.gpu_name ?? this.cfg.gpu}, ${inst.dph_total ?? offer.dph_total} USD/h)`);
      const remotePayload = `${REMOTE_DIR}/payload.json`;
      const remoteOut = `${REMOTE_DIR}/attestation.json`;
      const remoteProver = `${REMOTE_DIR}/blindseal-prover`;
      this.check(ctrl.signal);
      await this.run(inst, `mkdir -p ${REMOTE_DIR}`, ctrl.signal);
      await this.driver.scpTo(inst, this.cfg.proverBinary, remoteProver);
      await this.driver.scpTo(inst, job.payloadPath, remotePayload);
      await this.run(inst, `chmod 0755 ${remoteProver} && for i in $(seq 1 60); do curl -s -o /dev/null -m 2 ${MOONGATE_URL}/ && exit 0; sleep 2; done; echo moongate-server not ready >&2; tail -20 /var/log/moongate.log >&2; exit 5`, ctrl.signal);
      const cmd = ['env', `BLINDSEAL_PROVER_HOST=vast`, `BLINDSEAL_MOONGATE_URL=${MOONGATE_URL}`, remoteProver, '--mode', 'cuda', ...proverArgs(job, remotePayload, remoteOut)].map(shq).join(' ');
      const t0 = Date.now();
      const r = await this.driver.ssh(inst, cmd, ctrl.signal);
      if (r.code !== 0) throw new Error(`vast: prover exited ${r.code} on instance ${id}: ${r.stderr.trim().split('\n').slice(-5).join(' | ')}`);
      log(`vast: proof done in ${Math.round((Date.now() - t0) / 1000)} s`);
      await this.driver.scpFrom(inst, remoteOut, job.out);
      return JSON.parse(readFileSync(job.out, 'utf8')) as AttestationJson;
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      await destroy('done').catch(() => {});
    }
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
  }

  private async run(inst: VastInstance, command: string, signal: AbortSignal): Promise<void> {
    this.check(signal);
    const r = await this.driver.ssh(inst, command, signal);
    if (r.code !== 0) throw new Error(`vast: remote command failed (${r.code}): ${command.slice(0, 80)}: ${r.stderr.trim().slice(-400)}`);
  }

  private async waitForSsh(id: number, signal: AbortSignal): Promise<VastInstance> {
    const deadline = Date.now() + (this.cfg.sshTimeoutMs ?? 10 * 60_000);
    let delay = 2000;
    while (Date.now() < deadline) {
      this.check(signal);
      const inst = await this.driver.showInstance(id);
      if (inst?.actual_status === 'running' && inst.ssh_host && inst.ssh_port) {
        const r = await this.driver.ssh(inst, 'true', signal).catch((e: Error) => ({ code: 255, stdout: '', stderr: e.message }));
        if (r.code === 0) return inst;
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
      delay = Math.min(delay * 1.5, 15_000);
    }
    throw new Error(`vast: instance ${id} did not become reachable over ssh within ${(this.cfg.sshTimeoutMs ?? 600_000) / 1000} s`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    const done = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', done, { once: true });
  });
}

/// The real driver: the `vastai` CLI (pip package vastai) with --raw, and ssh/scp to the instance.
/// `spawnImpl` is injectable so the argument and environment handling can be tested without the CLI.
export function cliDriver(cfg: Pick<VastConfig, 'apiKeyFile'>, deps: { spawnImpl?: typeof spawn; spawnSyncImpl?: typeof spawnSync; vastai?: string; env?: NodeJS.ProcessEnv } = {}): VastDriver {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const vastai = deps.vastai ?? 'vastai';
  const baseEnv = deps.env ?? process.env;
  // read on every call so a rotated key is picked up, and never kept on this object
  const envWithKey = (): NodeJS.ProcessEnv => ({ ...baseEnv, VAST_API_KEY: readFileSync(cfg.apiKeyFile, 'utf8').trim() });

  const exec = (cmd: string, args: string[], opts: SpawnOptions & { signal?: AbortSignal } = {}): Promise<RemoteResult> =>
    new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
      let stdout = ''; let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  const vast = async (args: string[]): Promise<string> => {
    const r = await exec(vastai, [...args, '--raw'], { env: envWithKey() });
    if (r.code !== 0) throw new Error(`vastai ${args[0]} ${args[1] ?? ''} failed (${r.code}): ${r.stderr.trim().slice(-300)}`);
    return r.stdout;
  };
  const sshArgs = (inst: VastInstance): string[] => ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR'];
  return {
    async searchOffers(query, order) {
      const out = await vast(['search', 'offers', query, '-o', order]);
      return JSON.parse(out) as VastOffer[];
    },
    async createInstance(offerId, o) {
      const out = await vast(['create', 'instance', String(offerId), '--image', o.image, '--disk', String(o.diskGb), '--ssh', '--direct', '--onstart-cmd', o.onstart, '--label', o.label]);
      const j = JSON.parse(out) as { success?: boolean; new_contract?: number };
      if (!j.success || typeof j.new_contract !== 'number') throw new Error(`vastai create instance: unexpected reply ${out.slice(0, 200)}`);
      return j.new_contract;
    },
    async showInstance(id) {
      const out = await vast(['show', 'instance', String(id)]);
      const j = JSON.parse(out) as VastInstance | VastInstance[];
      return Array.isArray(j) ? j[0] : j;
    },
    async destroyInstance(id) { await vast(['destroy', 'instance', String(id)]); },
    destroyInstanceSync(id) {
      spawnSyncImpl(vastai, ['destroy', 'instance', String(id), '--raw'], { env: envWithKey(), stdio: 'ignore', timeout: 30_000 });
    },
    ssh(inst, command, signal) {
      return exec('ssh', [...sshArgs(inst), '-p', String(inst.ssh_port), `root@${inst.ssh_host}`, command], { signal });
    },
    async scpTo(inst, local, remote) {
      const r = await exec('scp', [...sshArgs(inst), '-P', String(inst.ssh_port), local, `root@${inst.ssh_host}:${remote}`]);
      if (r.code !== 0) throw new Error(`scp to instance failed (${r.code}): ${r.stderr.trim().slice(-300)}`);
    },
    async scpFrom(inst, remote, local) {
      const r = await exec('scp', [...sshArgs(inst), '-P', String(inst.ssh_port), `root@${inst.ssh_host}:${remote}`, local]);
      if (r.code !== 0) throw new Error(`scp from instance failed (${r.code}): ${r.stderr.trim().slice(-300)}`);
    },
  };
}
