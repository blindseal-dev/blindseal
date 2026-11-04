/// The two CLI steps a tick runs after the proxy: `blindseal attest` (prove the screened transfer call) and
/// `blindseal submit` (the gated transfer on mainnet). Both are the real CLI as child processes; dry run
/// replaces them with a fixture copy and a simulated submission that reports the fixture's known consume
/// signature. Child output is captured for the log, never the environment (it carries the RPC URL).
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_CONSUME_SIGNATURE } from './config.js';
import type { AttestationRecord } from './log.js';
import { blindsealCli, FIXTURE_ATTESTATION, fixturesDir } from './paths.js';

export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface RunOptions { env: NodeJS.ProcessEnv; timeoutMs: number; onLine?: (line: string) => void; track?: (kill: () => void) => void }

/// `blindseal <args>` with stdout/stderr captured (and streamed through onLine). Killed on timeout.
export function runBlindseal(args: string[], opts: RunOptions): Promise<RunResult> {
  const cli = blindsealCli();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...cli.args, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env });
    let stdout = '';
    let stderr = '';
    const cap = (s: string) => (s.length > 200_000 ? s.slice(-100_000) : s);
    child.stdout.on('data', (b) => { stdout = cap(stdout + b.toString()); for (const l of b.toString().split('\n')) if (l.trim()) opts.onLine?.(l); });
    child.stderr.on('data', (b) => { stderr = cap(stderr + b.toString()); for (const l of b.toString().split('\n')) if (l.trim()) opts.onLine?.(l); });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, opts.timeoutMs);
    opts.track?.(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export interface ToolCall { toolName: string; args: Record<string, unknown> }

interface AttestationFile { decisionId?: string; nullifier?: string; payloadHash?: string; expirySlot?: number; action?: { sourceAuthority?: string; recipient?: string; amount?: string } }

export function readAttestation(file: string): AttestationRecord {
  const a = JSON.parse(readFileSync(file, 'utf8')) as AttestationFile;
  return {
    file,
    decisionId: a.decisionId ?? '',
    nullifier: a.nullifier ?? '',
    payloadHash: a.payloadHash ?? '',
    expirySlot: typeof a.expirySlot === 'number' ? a.expirySlot : 0,
    prover: '',
  };
}

export interface AttestOptions {
  dryRun: boolean;
  tickDir: string;
  call: ToolCall;
  proverPath?: string;
  proverNote: string;
  auditDir?: string;
  noExpiry: boolean;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  track?: (kill: () => void) => void;
}

/// Prove the screened transfer call. Live: `blindseal attest toolcall.json --out attestation.json`, which
/// re-screens with the proven layers, appends the decision to the audit chain and runs the prover (hours on
/// CPU). Dry run: the mainnet sample attestation is copied into place and labelled as such.
export async function attestStep(o: AttestOptions): Promise<AttestationRecord> {
  mkdirSync(o.tickDir, { recursive: true, mode: 0o700 });
  const callFile = path.join(o.tickDir, 'toolcall.json');
  const outFile = path.join(o.tickDir, 'attestation.json');
  writeFileSync(callFile, JSON.stringify(o.call, null, 2) + '\n', { mode: 0o600 });
  if (o.dryRun) {
    copyFileSync(path.join(fixturesDir(), FIXTURE_ATTESTATION), outFile);
    return { ...readAttestation(outFile), prover: `dry run: copied tests/fixtures/${FIXTURE_ATTESTATION}` };
  }
  const args = ['attest', callFile, '--out', outFile];
  if (o.proverPath) args.push('--prover', o.proverPath);
  if (o.auditDir) args.push('--audit-dir', o.auditDir);
  if (o.noExpiry) args.push('--no-expiry');
  const r = await runBlindseal(args, { env: o.env, timeoutMs: 8 * 3600_000, onLine: o.onLine, track: o.track });
  if (r.code !== 0) throw new Error(`blindseal attest exited ${r.code}: ${lastLines(r.stderr || r.stdout)}`);
  return { ...readAttestation(outFile), prover: o.proverNote };
}

export interface SubmitOptions {
  dryRun: boolean;
  attestationFile: string;
  walletPath: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  track?: (kill: () => void) => void;
}

/// Consume the attestation through transfer-gate. Live: a `--check` read first (an already-consumed
/// nullifier is a hard stop, nothing is sent), then `blindseal submit --wallet`. Dry run: the fixture's
/// known consume signature, flagged simulated.
export async function submitStep(o: SubmitOptions): Promise<{ signature: string; simulated: boolean }> {
  if (o.dryRun) return { signature: FIXTURE_CONSUME_SIGNATURE, simulated: true };
  const check = await runBlindseal(['submit', o.attestationFile, '--check'], { env: o.env, timeoutMs: 120_000, onLine: o.onLine, track: o.track });
  if (check.code !== 0) throw new Error(`blindseal submit --check exited ${check.code}: ${lastLines(check.stderr || check.stdout)}`);
  if (/: CONSUMED/.test(check.stdout)) throw new Error('nullifier already consumed on mainnet; not sending');
  const r = await runBlindseal(['submit', o.attestationFile, '--wallet', o.walletPath], { env: o.env, timeoutMs: 600_000, onLine: o.onLine, track: o.track });
  if (r.code !== 0) throw new Error(`blindseal submit exited ${r.code}: ${lastLines(r.stderr || r.stdout)}`);
  const m = /gated transfer: (\S+)/.exec(r.stdout);
  if (!m) throw new Error(`blindseal submit printed no signature: ${lastLines(r.stdout)}`);
  return { signature: m[1]!, simulated: false };
}

function lastLines(s: string, n = 6): string {
  return s.trim().split('\n').slice(-n).join(' | ').slice(0, 1200);
}
