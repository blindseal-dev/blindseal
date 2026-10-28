/// `blindseal attest` — a REAL screened decision → a Groth16 attestation.
///
/// 1. Screens the tool call with the proven layers (L0 decode-then-L1, L1 heuristics) — the same
///    code the proxy runs. A non-clean verdict stops here: there is no proof for a blocked call.
/// 2. Appends the decision to the hash-chained audit log (~/.blindseal/audit.log): content-free,
///    just decisionId / verdict / payloadHash. That entry is the decision the attestation names.
/// 3. Derives the on-chain action from the payload (chain/action-binding.ts — the same rule the guest
///    asserts before hashing, release 0.7.0): target program, instruction discriminator, source
///    authority, recipient, mint, amount. `--target-program` / `--instruction`, when given, must
///    equal what the payload describes; a payload that is not an on-chain action, or that describes
///    a different one, is refused here — before the prover is resolved or started — since the guest
///    would refuse it anyway.
/// 4. Runs the local prover (crates/prover) with that payload + action → attestation.json.
///
/// Usage:
///   blindseal attest <toolcall.json> --out <attestation.json> [--target-program <id>]
///     [--instruction <16 hex>] [--expiry <slot> | --no-expiry] [--prover <path>] [--audit-dir <dir>]
///   expiry defaults to the current mainnet slot + 40,000 (≈ 4.4 h, fetched over RPC); the prover binary is
///   resolved by src/prover/resolve.ts (--prover, $BLINDSEAL_PROVER, ~/.blindseal/bin, download).
///   toolcall.json: { "toolName": "transfer_sol", "args": { "to": "...", "lamports": 1000000, "from": "..." } }
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { redactValue } from '@blindseal/redactor';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runLayer0, makeLayer0Result } from '../detection/layer0-decoder.js';
import { runLayer1 } from '../detection/layer1-heuristics.js';
import { BindError, GATED_TRANSFER_DISC, TRANSFER_GATE_ID, actionFromPayload, checkActionBinding, type BoundAction } from '../chain/action-binding.js';
import { openAudit, toChainVerdict } from '@blindseal/audit';
import { rpcUrl } from '@blindseal/chain-reads';
import { ProverUnavailableError, resolveProver } from '../prover/resolve.js';
import { blindsealHome } from '../paths.js';

const HELP = `blindseal attest — screen a tool call, record the decision, prove it

Usage:
  blindseal attest <toolcall.json> --out <attestation.json> [flags]

Flags
  --out <file>               where to write attestation.json (default ./attestation.json)
  --target-program <id>      the gated program the action targets (base58). Optional: the payload
                             decides it (args.program, else transfer-gate); a different value is refused
  --instruction <16 hex>     instruction discriminator. Optional: the payload decides it
                             (args.instruction / args.method, else transfer-gate gated_transfer)
  --expiry <slot>            expirySlot (default: current slot + 40000 ≈ 4.4 h, fetched from the RPC; proving takes hours)
  --no-expiry                write the "no expiry" sentinel (2000000000) instead of fetching a slot
  --prover <path>            prover binary (default: $BLINDSEAL_PROVER, then ~/.blindseal/bin/,
                             downloaded from the GitHub release on first use)
  --audit-dir <dir>          audit base dir (default ~/.blindseal)
  --help, -h                 this help

The payload must describe exactly the action the proof binds (the guest checks it before hashing):
a call that is not an on-chain transfer, or a flag that disagrees with it, is refused before proving.
Only clean verdicts are attested. The decision is appended to the hash-chained audit log first (the call
itself is kept redacted + encrypted locally); the attestation is also copied to <audit dir>/attestations/,
where \`blindseal run\` (the dashboard) lists it.
RPC for the slot: $BLINDSEAL_RPC_URL, else the public mainnet endpoint.
`;

/// Native SOL: the binding reports the all-zero key; the prover takes '' for it.
const NATIVE_MINT_B58 = '11111111111111111111111111111111';
/// The "no expiry" sentinel the circuit accepts (--no-expiry).
export const NO_EXPIRY_SLOT = '2000000000';
/// Default validity window: current slot + this many slots (~10 minutes at 400ms/slot).
export const EXPIRY_WINDOW_SLOTS = 40_000;   // ≈ 4.4 h at 0.4 s/slot: room for a CPU proof (hours) plus submission
const SLOT_SECONDS = 0.4;

/// Wall-clock of the last successful proof on this machine (~/.blindseal/prover-times.json), used to
/// warn before proving when the previous proof took more than half the expiry window.
export function proverTimesPath(): string { return path.join(blindsealHome(), 'prover-times.json'); }
export function readLastProofSeconds(file: string = proverTimesPath()): number | undefined {
  try { const j = JSON.parse(readFileSync(file, 'utf8')) as { lastSeconds?: number }; return typeof j.lastSeconds === 'number' ? j.lastSeconds : undefined; } catch { return undefined; }
}
export function recordProofSeconds(seconds: number, file: string = proverTimesPath()): void {
  try { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify({ lastSeconds: Math.round(seconds), at: new Date().toISOString() }) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
}
/// The warning text when the last proof exceeded half the window (undefined = no warning).
export function expiryWarning(lastSeconds: number | undefined, windowSlots: number = EXPIRY_WINDOW_SLOTS): string | undefined {
  if (lastSeconds === undefined) return undefined;
  const windowSeconds = windowSlots * SLOT_SECONDS;
  if (lastSeconds <= windowSeconds / 2) return undefined;
  const h = (x: number) => (x / 3600).toFixed(1) + ' h';
  return `blindseal attest: your last proof on this machine took ${h(lastSeconds)}; the default expiry window is ${h(windowSeconds)}. ` +
    `If proving runs long the attestation may expire before you can submit it — pass --expiry <slot> for a later slot, or --no-expiry.`;
}

/// A private scratch dir for the prover's input: mkdtemp under os.tmpdir() (mode 0700), files
/// written 0600, removed in `finally` — and on SIGINT/SIGTERM, where the handler kills the
/// prover, removes the dir, then re-raises the signal so the exit status is unchanged. The
/// payload is the screened tool call verbatim, so it must not outlive the run or be readable
/// by other local users.
export async function withPrivateTempDir<T>(
  fn: (dir: string, track: (child: ChildProcess) => void) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-attest-'));
  chmodSync(dir, 0o700);
  const children = new Set<ChildProcess>();
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  const handlers = new Map<NodeJS.Signals, () => void>();
  const unhook = () => { for (const [sig, h] of handlers) process.removeListener(sig, h); handlers.clear(); };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const h = () => {
      for (const c of children) { try { c.kill(sig); } catch { /* already gone */ } }
      cleanup();
      unhook();
      process.kill(process.pid, sig); // re-raise: default action now that our handler is gone
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
  try {
    return await fn(dir, (c) => { children.add(c); c.once('exit', () => children.delete(c)); });
  } finally {
    cleanup();
    unhook();
  }
}

/// Write a file readable only by this user (0600) inside a withPrivateTempDir dir.
export function writePrivateFile(file: string, data: string): void {
  writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600); // the umask could only narrow it, but be explicit
}

/// Run the prover asynchronously (a blocking spawnSync would keep signal handlers from running
/// for the hours a CPU proof takes). Resolves with the exit code; rejects if it cannot start.
function runProver(prover: string, args: string[], track: (c: ChildProcess) => void): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(prover, args, { stdio: 'inherit' });
    track(child);
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

interface Opts {
  file?: string;
  out: string;
  targetProgram?: string;
  instruction?: string;
  expiry?: string;
  noExpiry: boolean;
  prover?: string;
  auditDir: string;
  help?: boolean;
}

function parse(argv: string[]): Opts {
  const o: Opts = { out: 'attestation.json', noExpiry: false, auditDir: path.join(os.homedir(), '.blindseal') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--out') o.out = argv[++i]!;
    else if (a === '--target-program') o.targetProgram = argv[++i];
    else if (a === '--instruction') o.instruction = argv[++i];
    else if (a === '--expiry') o.expiry = argv[++i]!;
    else if (a === '--no-expiry') o.noExpiry = true;
    else if (a === '--prover') o.prover = argv[++i];
    else if (a === '--audit-dir') o.auditDir = argv[++i]!;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else o.file = a;
  }
  return o;
}

/// Current slot over JSON-RPC (BLINDSEAL_RPC_URL or the public mainnet endpoint).
export async function fetchCurrentSlot(fetchImpl: typeof fetch = fetch): Promise<number> {
  const url = rpcUrl();
  if (!url) throw new Error('RPC reads are disabled (BLINDSEAL_RPC_URL=off)');
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`getSlot: ${j.error.message}`);
  if (typeof j.result !== 'number') throw new Error('getSlot returned no slot');
  return j.result;
}

/// --expiry <slot> | --no-expiry | current slot + EXPIRY_WINDOW_SLOTS. Throws when the RPC is
/// unreachable and neither flag was given.
export async function resolveExpiry(o: { expiry?: string; noExpiry: boolean }, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (o.expiry !== undefined && o.noExpiry) throw new Error('--expiry and --no-expiry are mutually exclusive');
  if (o.noExpiry) return NO_EXPIRY_SLOT;
  if (o.expiry !== undefined) {
    if (!/^\d+$/.test(o.expiry)) throw new Error(`--expiry must be a slot number, got "${o.expiry}"`);
    return o.expiry;
  }
  let slot: number;
  try {
    slot = await fetchCurrentSlot(fetchImpl);
  } catch (e) {
    throw new Error(
      `could not fetch the current slot (${(e as Error).message}). ` +
      'Pass --expiry <slot> to set it explicitly, or --no-expiry for an attestation that never expires. ' +
      'Set BLINDSEAL_RPC_URL to use your own RPC endpoint.',
    );
  }
  return String(slot + EXPIRY_WINDOW_SLOTS);
}

export async function runAttestCli(argv: string[]): Promise<number> {
  let o: Opts;
  try { o = parse(argv); } catch (e) { process.stderr.write(`blindseal attest: ${(e as Error).message}\n${HELP}`); return 2; }
  if (o.help || !o.file) { process.stdout.write(HELP); return o.help ? 0 : 2; }

  // The payload the proof commits to: the canonical tool-call JSON exactly as screened. Its action is
  // checked first — the guest refuses a payload that does not describe the action it binds, so a
  // mismatch is refused here, before the prover is resolved or started.
  const raw = readFileSync(o.file, 'utf8');
  const call = JSON.parse(raw) as { toolName: string; args: unknown };
  const payload = JSON.stringify({ tool: call.toolName, args: call.args });
  let derived: BoundAction | undefined;
  let action: BoundAction;
  try {
    derived = actionFromPayload(payload);
    action = checkActionBinding(payload, {
      ...derived,
      targetProgram: o.targetProgram ?? derived.targetProgram,
      instruction: o.instruction ?? derived.instruction,
    });
  } catch (e) {
    if (!(e instanceof BindError)) throw e;
    const why =
      e.code === 'not-an-action' ? 'the call is not a recognizable on-chain action'
      : e.code === 'target-program-mismatch' ? `--target-program ${o.targetProgram} is not the program the call targets (${derived?.targetProgram})`
      : e.code === 'instruction-mismatch' ? `--instruction ${o.instruction} is not the instruction the call names (${derived?.instruction})`
      : 'the call does not describe an on-chain action the proof could bind';
    process.stderr.write(`blindseal attest: refused (${e.code}): ${why}; nothing was proved\n`);
    return 1;
  }

  // transfer-gate executes exactly one thing — gated_transfer of native SOL. A call that targets it with
  // another instruction or a mint would bind, but the gate could never consume the proof: refuse
  // before hours of proving. (Gate your own program by naming it in the call: args.program.)
  if (action.targetProgram === TRANSFER_GATE_ID && (action.instruction !== GATED_TRANSFER_DISC || action.mint !== NATIVE_MINT_B58)) {
    process.stderr.write(`blindseal attest: refused: transfer-gate only executes gated_transfer (${GATED_TRANSFER_DISC}) of native SOL; ` +
      `this call names instruction ${action.instruction}${action.mint !== NATIVE_MINT_B58 ? ` and mint ${action.mint}` : ''}, so its attestation could never be consumed; nothing was proved\n`);
    return 1;
  }

  // Resolve the prover and the expiry slot before touching the audit log, so a missing binary or
  // an unreachable RPC leaves no half-done decision behind.
  let prover: string;
  try {
    prover = await resolveProver({ explicit: o.prover });
  } catch (e) {
    if (e instanceof ProverUnavailableError) { process.stderr.write(e.message + '\n'); return 1; }
    process.stderr.write(`blindseal attest: ${(e as Error).message}\n`);
    return 1;
  }
  let expiry: string;
  if (o.expiry === undefined && !o.noExpiry) { const w = expiryWarning(readLastProofSeconds()); if (w) process.stderr.write(w + '\n'); }
  try {
    expiry = await resolveExpiry(o);
  } catch (e) {
    process.stderr.write(`blindseal attest: ${(e as Error).message}\n`);
    return 1;
  }

  const payloadHash = '0x' + createHash('sha256').update(payload).digest('hex');

  // 1) screen with the proven layers (what the guest re-runs and asserts clean)
  const l0 = runLayer0(payload);
  const result = l0.fired ? makeLayer0Result(l0) : runLayer1(payload);
  const verdict = result.verdict;

  // 2) record the decision in the hash-chained audit log, clean or not
  const decisionId = 'd_' + randomBytes(8).toString('hex');
  const audit = openAudit(o.auditDir);
  // The chain records the canonical verdict (CLEAN_VERDICT = "pass" for a clean call), the same
  // vocabulary `blindseal verify` and the browser verifier test a clean window against.
  const entry = audit.chain.append({ decisionId, verdict: toChainVerdict(verdict), payloadHash });
  // What the decision was about, for the local dashboard: redacted, encrypted (like the proxy's).
  audit.content.put(decisionId, {
    type: 'attest', direction: 'request', toolName: call.toolName, verdict, patterns: result.detectedPatterns,
    args: redactValue(call.args ?? null).redacted,
  });
  process.stdout.write(`decision ${decisionId}: ${verdict} → ${entry.verdict} (audit #${entry.index} ${entry.hash.slice(0, 18)}…)\n`);
  if (verdict !== 'clean') {
    process.stderr.write(`blindseal attest: verdict is ${verdict} (${result.detectedPatterns.join(', ')}); no attestation for a non-clean call\n`);
    return 1;
  }

  // 3) the on-chain action the gated program will execute: `action`, checked against the payload above
  // 4) prove — the payload goes to the prover through a private temp dir, removed afterwards
  const proverArgs = (payloadFile: string) => [
    '--payload', payloadFile, '--out', o.out, '--decision-id', decisionId,
    '--chain-id', String(action.chainId),
    '--target-program', action.targetProgram, '--source-authority', action.sourceAuthority,
    '--recipient', action.recipient, '--mint', action.mint === NATIVE_MINT_B58 ? '' : action.mint, '--amount', action.amount,
    '--instruction', action.instruction, '--expiry', expiry,
  ];
  return withPrivateTempDir(async (tmpDir, track) => {
    const tmpPayload = path.join(tmpDir, 'payload.json');
    writePrivateFile(tmpPayload, payload);
    process.stdout.write(`proving (this takes a while on CPU)…\n`);
    const t0 = Date.now();
    const status = await runProver(prover, proverArgs(tmpPayload), track);
    if (status !== 0) { process.stderr.write(`blindseal attest: prover exited ${status}\n`); return 1; }
    recordProofSeconds((Date.now() - t0) / 1000);
    // A copy beside the audit chain, where `blindseal run` (the local dashboard) lists attestations.
    try {
      const dir = path.join(o.auditDir, 'attestations');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, `${decisionId}.json`), readFileSync(o.out), { mode: 0o600 });
    } catch { /* best effort: the attestation at --out is the deliverable */ }
    process.stdout.write(`attestation written: ${o.out} (decision ${decisionId}, payloadHash ${payloadHash}, expirySlot ${expiry}${expiry === NO_EXPIRY_SLOT ? ' = no expiry' : ''})\n`);
    return 0;
  });
}
