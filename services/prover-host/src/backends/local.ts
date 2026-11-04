/// `local` backend: spawns the prover binary (crates/prover) on this machine, exactly as `blindseal
/// attest` does. The binary comes from config.proverPath, else from the CLI's resolution order
/// (BLINDSEAL_PROVER, ~/.blindseal/bin, a source checkout, the pinned release download).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveProver } from '../upstream.js';
import type { AttestationJson, ProofBackend, ProofJob } from './types.js';

/// Native SOL: the binding reports the all-zero key; the prover takes '' for it.
export const NATIVE_MINT_B58 = '11111111111111111111111111111111';

export interface LocalBackendOptions {
  proverPath?: string;
  log?: (line: string) => void;
}

/// The prover's argv for a job — the same list `blindseal attest` builds.
export function proverArgs(job: ProofJob): string[] {
  const a = job.action;
  const args = [
    '--payload', job.payloadPath, '--out', job.out,
    '--chain-id', String(a.chainId),
    '--target-program', a.targetProgram, '--source-authority', a.sourceAuthority,
    '--recipient', a.recipient, '--mint', a.mint === NATIVE_MINT_B58 ? '' : a.mint, '--amount', a.amount,
    '--instruction', a.instruction, '--expiry', job.expirySlot,
  ];
  if (job.decisionId) args.push('--decision-id', job.decisionId);
  if (job.nonce) args.push('--nonce', job.nonce);
  return args;
}

export class ProverExitError extends Error {
  constructor(public readonly code: number | null, public readonly signal: NodeJS.Signals | null, stderrTail: string) {
    super(`prover exited ${code ?? `by signal ${signal}`}${stderrTail ? `: ${stderrTail}` : ''}`);
    this.name = 'ProverExitError';
  }
}

export class LocalBackend implements ProofBackend {
  readonly name = 'local' as const;
  private binary?: Promise<string>;

  constructor(private readonly opts: LocalBackendOptions = {}) {}

  /// Resolved once and cached; a failed resolution is retried on the next job.
  private resolveBinary(): Promise<string> {
    if (!this.binary) {
      this.binary = resolveProver({ explicit: this.opts.proverPath, log: this.opts.log }).catch((e) => { this.binary = undefined; throw e; });
    }
    return this.binary;
  }

  async prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson> {
    const bin = await this.resolveBinary();
    signal.throwIfAborted();
    await this.run(bin, proverArgs(job), signal);
    return JSON.parse(readFileSync(job.out, 'utf8')) as AttestationJson;
  }

  private run(bin: string, args: string[], signal: AbortSignal): Promise<void> {
    const log = this.opts.log ?? (() => {});
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrTail = '';
      const onAbort = () => { child.kill('SIGTERM'); };
      signal.addEventListener('abort', onAbort, { once: true });
      // The prover prints VKEY and PROVE_MS on stdout; keep those lines in the host log.
      child.stdout.on('data', (d: Buffer) => { for (const line of d.toString().split('\n')) if (line.trim()) log(`prover: ${line.trim()}`); });
      child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
      child.once('error', (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
      child.once('exit', (code, sig) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        else if (code === 0) resolve();
        else reject(new ProverExitError(code, sig, stderrTail.trim().split('\n').slice(-3).join(' | ')));
      });
    });
  }
}
