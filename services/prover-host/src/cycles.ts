/// The per-job cycle cap: before a job is charged and queued, the prover runs it in the SP1 executor
/// (`BLINDSEAL_EXECUTE=1`: real guest execution, no proof, seconds) and reports the cycle count. Proving
/// time grows with cycles, so a payload that would take far longer than a normal proof is refused up front
/// instead of tying up the queue (or a rented GPU) for hours. The executor is also the cheapest check that
/// the guest accepts the job at all.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proverArgs } from './backends/prover-args.js';
import type { ProofJob } from './backends/types.js';

export class CycleMeasureError extends Error {
  constructor(message: string) { super(message); this.name = 'CycleMeasureError'; }
}

/// Runs `bin` in executor mode on `payload` + the job's action; resolves the CYCLES it prints. A guest that
/// refuses (non-zero exit) rejects with the prover's last stderr lines.
export function measureCycles(bin: string, payload: string, job: Omit<ProofJob, 'payloadPath' | 'out'>): Promise<number> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-cycles-'));
  const payloadPath = path.join(dir, 'payload.json');
  writeFileSync(payloadPath, payload, { mode: 0o600 });
  const args = proverArgs({ ...job, payloadPath, out: path.join(dir, 'unused.json') }, payloadPath, path.join(dir, 'unused.json'));
  return new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BLINDSEAL_EXECUTE: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    child.once('error', (e) => reject(new CycleMeasureError(`executor did not start: ${e.message}`)));
    child.once('exit', (code) => {
      const m = /^CYCLES (\d+)$/m.exec(out);
      if (code === 0 && m) resolve(Number(m[1]));
      else reject(new CycleMeasureError(`the guest refused the job in the executor (exit ${code}): ${err.trim().split('\n').slice(-2).join(' | ')}`));
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}
