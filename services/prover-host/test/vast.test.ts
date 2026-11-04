import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VastBackend, cliDriver, liveInstances, offerQuery, ONSTART, type VastConfig, type VastDriver, type VastInstance, type VastOffer } from '../src/backends/vast.js';
import type { ProofJob } from '../src/backends/types.js';

const ATT = { version: 1, decisionId: null, chainId: 1, payloadHash: '0x11', policyRoot: '0x22', detectorVersion: '0x33', actionHash: '0x44', nullifier: '0x55', expirySlot: 2000000000, nonce: '0x66', action: { targetProgram: 'T', sourceAuthority: 'S', instruction: '0x0102030405060708', recipient: 'R', mint: '', amount: '1' }, publicInputs: ['0x'], proof: { protocol: 'groth16', curve: 'bn254', bytes: '0x' }, proveMs: 1234, prover: { mode: 'cuda', host: 'vast', version: '0.0.0' } };

let tmp: string;
let job: ProofJob;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'blindseal-vast-'));
  writeFileSync(path.join(tmp, 'payload.json'), '{"tool":"transfer_sol","args":{}}');
  writeFileSync(path.join(tmp, 'prover'), '#!/bin/sh\n');
  job = {
    id: 'j1', payloadPath: path.join(tmp, 'payload.json'), out: path.join(tmp, 'att.json'),
    action: { chainId: 1, targetProgram: 'T', sourceAuthority: 'S', instruction: '0x0102030405060708', recipient: 'R', mint: '', amount: '1' },
    expirySlot: 2000000000, nonce: '0x' + '66'.repeat(32), decisionId: 'd_1',
  };
});

function cfg(over: Partial<VastConfig> = {}): VastConfig {
  return { apiKeyFile: path.join(tmp, 'key'), gpu: 'RTX_4090', maxPriceUsdPerHour: 0.6, maxInstanceAgeMinutes: 90, image: 'public.ecr.aws/succinct-labs/sp1-gpu:8fd1ef7', diskGb: 100, proverBinary: path.join(tmp, 'prover'), sshTimeoutMs: 5000, ...over };
}

/// A fake Vast: records every call, "runs" the prover by writing the attestation, and can be made to fail at any step.
function fakeDriver(opts: { offers?: VastOffer[]; proverExit?: number; readyAfter?: number; hang?: boolean; destroyFails?: number } = {}) {
  const calls: string[] = [];
  let shows = 0;
  let destroyed = 0;
  let destroyAttempts = 0;
  const inst: VastInstance = { id: 4242, actual_status: 'running', ssh_host: 'ssh.example.invalid', ssh_port: 2222, gpu_name: 'RTX 4090', dph_total: 0.41 };
  const files = new Map<string, string>();
  const d: VastDriver & { calls: string[]; destroyed: () => number } = {
    calls,
    destroyed: () => destroyed,
    async searchOffers(q, order) { calls.push(`search ${order}`); return opts.offers ?? [{ id: 9, dph_total: 0.55, gpu_name: 'RTX_4090', cpu_ram: 64, disk_space: 200 }, { id: 7, dph_total: 0.41, gpu_name: 'RTX_4090', cpu_ram: 32, disk_space: 120 }]; },
    async createInstance(offerId, o) { calls.push(`create ${offerId} ${o.image} ${o.diskGb} ${o.label}`); expect(o.onstart).toBe(ONSTART); return 4242; },
    async showInstance(id) { calls.push(`show ${id}`); shows++; return shows > (opts.readyAfter ?? 1) ? inst : { id, actual_status: 'loading' }; },
    async destroyInstance(id) { destroyAttempts++; calls.push(`destroy ${id}`); if (opts.destroyFails && destroyAttempts <= opts.destroyFails) throw new Error('api 500'); destroyed++; },
    destroyInstanceSync(id) { calls.push(`destroy-sync ${id}`); destroyed++; },
    async ssh(_i, command, signal) {
      calls.push(`ssh ${command.split(' ').slice(0, 3).join(' ')}`);
      const isProver = command.includes(`'--mode' 'cuda'`);
      if (opts.hang && isProver) {
        await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve(), { once: true }); });
        return { code: 143, stdout: '', stderr: 'killed' };
      }
      if (isProver) {
        expect(command).toContain(`'BLINDSEAL_PROVER_HOST=vast'`);
        expect(command).toContain(`'--mode' 'cuda'`);
        expect(command).toContain(`'--nonce' '${job.nonce}'`);
        expect(command).toContain(`'--decision-id' 'd_1'`);
        if ((opts.proverExit ?? 0) !== 0) return { code: opts.proverExit!, stdout: '', stderr: 'groth16 prove failed' };
        files.set('/work/attestation.json', JSON.stringify(ATT));
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async scpTo(_i, local, remote) { calls.push(`scpTo ${path.basename(local)} ${remote}`); files.set(remote, readFileSync(local, 'utf8')); },
    async scpFrom(_i, remote, local) { calls.push(`scpFrom ${remote}`); const c = files.get(remote); if (c === undefined) throw new Error(`no ${remote}`); writeFileSync(local, c); },
  };
  return d;
}

describe('VastBackend', () => {
  it('picks the cheapest offer under the cap, provisions, proves, copies the attestation back and destroys the instance', async () => {
    const d = fakeDriver();
    const log: string[] = [];
    const att = await new VastBackend(cfg({ log: (l) => log.push(l) }), d).prove(job, new AbortController().signal);
    expect(att.prover).toEqual({ mode: 'cuda', host: 'vast', version: '0.0.0' });
    expect(JSON.parse(readFileSync(job.out, 'utf8')).proveMs).toBe(1234);
    expect(d.calls[0]).toBe('search dph_total');
    expect(d.calls[1]).toBe('create 7 public.ecr.aws/succinct-labs/sp1-gpu:8fd1ef7 100 blindseal-j1');
    expect(d.calls).toContain('scpTo prover /work/blindseal-prover');
    expect(d.calls).toContain('scpTo payload.json /work/payload.json');
    expect(d.calls).toContain('scpFrom /work/attestation.json');
    expect(d.calls[d.calls.length - 1]).toBe('destroy 4242');
    expect(d.destroyed()).toBe(1);
    expect(liveInstances()).toEqual([]);
    expect(log.some((l) => /offer 7 .* 0\.410 USD\/h/.test(l))).toBe(true);
  });

  it('no offer under the cap: fails before creating anything', async () => {
    const d = fakeDriver({ offers: [{ id: 1, dph_total: 0.9, gpu_name: 'RTX_4090', cpu_ram: 64, disk_space: 200 }] });
    await expect(new VastBackend(cfg(), d).prove(job, new AbortController().signal)).rejects.toThrow(/no RTX_4090 offer under 0\.6 USD\/h/);
    expect(d.calls).toEqual(['search dph_total']);
  });

  it('a failed proof still destroys the instance and surfaces the prover\'s stderr', async () => {
    const d = fakeDriver({ proverExit: 101 });
    await expect(new VastBackend(cfg(), d).prove(job, new AbortController().signal)).rejects.toThrow(/prover exited 101 .*groth16 prove failed/);
    expect(d.destroyed()).toBe(1);
    expect(liveInstances()).toEqual([]);
  });

  it('the caller\'s abort destroys the instance while the prover is still running', async () => {
    const d = fakeDriver({ hang: true });
    const ac = new AbortController();
    const p = new VastBackend(cfg(), d).prove(job, ac.signal);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort(new Error('operator stop'));
    await expect(p).rejects.toThrow();
    expect(d.destroyed()).toBe(1);
    expect(d.calls.filter((c) => c.startsWith('destroy'))).toHaveLength(1);
  });

  it('the watchdog destroys the instance when maxInstanceAgeMinutes passes', async () => {
    const d = fakeDriver({ hang: true });
    const p = new VastBackend(cfg({ maxInstanceAgeMinutes: 0.0005 }), d).prove(job, new AbortController().signal); // 30 ms
    await expect(p).rejects.toThrow(/watchdog|killed|exited/);
    expect(d.destroyed()).toBe(1);
  });

  it('a destroy that fails keeps the instance registered for the exit hook', async () => {
    const d = fakeDriver({ destroyFails: 1 });
    const log: string[] = [];
    await new VastBackend(cfg({ log: (l) => log.push(l) }), d).prove(job, new AbortController().signal);
    expect(liveInstances()).toEqual([4242]);
    expect(log.some((l) => /destroying instance 4242 failed .*vastai show instances/.test(l))).toBe(true);
    // the exit hook path
    process.emit('exit', 0);
    expect(d.calls[d.calls.length - 1]).toBe('destroy-sync 4242');
    expect(liveInstances()).toEqual([]);
  });

  it('offerQuery carries every cap', () => {
    expect(offerQuery(cfg())).toBe('gpu_name=RTX_4090 num_gpus=1 rentable=true rented=false cpu_ram>=32 disk_space>=100 reliability>=0.98 dph<=0.6');
  });
});

describe('cliDriver', () => {
  it('passes the key to vastai through VAST_API_KEY only, asks for --raw, and parses the replies', async () => {
    writeFileSync(path.join(tmp, 'key'), 'secret-key-value\n');
    const spawned: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const replies: Record<string, string> = {
      search: JSON.stringify([{ id: 7, dph_total: 0.41, gpu_name: 'RTX_4090', cpu_ram: 32, disk_space: 120 }]),
      create: JSON.stringify({ success: true, new_contract: 4242 }),
      show: JSON.stringify({ id: 4242, actual_status: 'running', ssh_host: 'h', ssh_port: 22 }),
      destroy: JSON.stringify({ success: true }),
    };
    const spawnImpl = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      spawned.push({ cmd, args, env: opts.env });
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setTimeout(() => { child.stdout.emit('data', Buffer.from(replies[args[0]!] ?? '')); child.emit('close', 0); }, 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const d = cliDriver({ apiKeyFile: path.join(tmp, 'key') }, { spawnImpl, env: { PATH: '/usr/bin' } });
    expect(await d.searchOffers('gpu_name=RTX_4090', 'dph_total')).toEqual([{ id: 7, dph_total: 0.41, gpu_name: 'RTX_4090', cpu_ram: 32, disk_space: 120 }]);
    expect(await d.createInstance(7, { image: 'img', diskGb: 100, onstart: ONSTART, label: 'l' })).toBe(4242);
    expect((await d.showInstance(4242))?.ssh_host).toBe('h');
    await d.destroyInstance(4242);
    await d.ssh({ id: 4242, ssh_host: 'h', ssh_port: 22 }, 'true');
    for (const s of spawned.filter((x) => x.cmd === 'vastai')) {
      expect(s.args[s.args.length - 1]).toBe('--raw');
      expect(s.args.join(' ')).not.toContain('secret-key-value');
      expect(s.env?.VAST_API_KEY).toBe('secret-key-value');
    }
    expect(spawned.find((x) => x.args[0] === 'create')!.args).toEqual(['create', 'instance', '7', '--image', 'img', '--disk', '100', '--ssh', '--direct', '--onstart-cmd', ONSTART, '--label', 'l', '--raw']);
    const ssh = spawned.find((x) => x.cmd === 'ssh')!;
    expect(ssh.args.slice(-3)).toEqual(['-p', '22', 'root@h', 'true'].slice(-3));
    expect(ssh.env).toBeUndefined();
  });
});
