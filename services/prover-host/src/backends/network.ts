/// Network backend: the local prover binary in `--mode network`, which sends the payload (the screened
/// tool call) and the policy to the Succinct prover network. The same explicit opt-in as the binary:
/// `acknowledged: true` in the config AND BLINDSEAL_NETWORK_ACKNOWLEDGED=1 for the child, plus
/// NETWORK_PRIVATE_KEY (what sp1-sdk reads) in this process's environment, passed through untouched
/// and never logged. The prover must be built with --features network.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { proverArgs } from './prover-args.js';
import type { AttestationJson, ProofBackend, ProofJob } from './types.js';

export interface NetworkConfig {
  proverBinary: string;
  /// the operator's statement that sending payloads to the prover network is intended
  acknowledged: boolean;
  log?: (line: string) => void;
}

export class NetworkBackend implements ProofBackend {
  readonly name = 'network' as const;
  constructor(private readonly cfg: NetworkConfig, private readonly deps: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}) {}

  async prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson> {
    const env = this.deps.env ?? process.env;
    if (!this.cfg.acknowledged) throw new Error('network backend: not acknowledged; set backends.network.acknowledged = true only if sending the payload and the policy to the Succinct prover network is intended');
    if (!env.NETWORK_PRIVATE_KEY) throw new Error('network backend: NETWORK_PRIVATE_KEY is not set (the prover network account key sp1-sdk reads)');
    (this.cfg.log ?? (() => {}))(`network: job ${job.id}: the payload and the policy leave this machine for the Succinct prover network`);
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    const args = ['--mode', 'network', ...proverArgs(job, job.payloadPath, job.out)];
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawnImpl(this.cfg.proverBinary, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, BLINDSEAL_NETWORK_ACKNOWLEDGED: '1' }, signal });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`network backend: prover exited ${code}`);
    return JSON.parse(readFileSync(job.out, 'utf8')) as AttestationJson;
  }
}
