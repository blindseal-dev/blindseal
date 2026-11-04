/// The prover's command line for a job, shared by every backend that runs crates/prover somewhere.
import type { ProofJob } from './types.js';

export function proverArgs(job: ProofJob, payloadPath: string, out: string): string[] {
  const a = job.action;
  const args = [
    '--payload', payloadPath, '--out', out,
    '--chain-id', String(a.chainId),
    '--target-program', a.targetProgram, '--source-authority', a.sourceAuthority,
    '--recipient', a.recipient, '--mint', a.mint, '--amount', a.amount,
    '--instruction', a.instruction, '--expiry', String(job.expirySlot),
  ];
  if (job.nonce) args.push('--nonce', job.nonce);
  if (job.decisionId) args.push('--decision-id', job.decisionId);
  return args;
}

/// Shell-quote one argument for a remote `ssh host <command>` line (ssh joins its arguments with spaces
/// and hands them to the remote shell).
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
