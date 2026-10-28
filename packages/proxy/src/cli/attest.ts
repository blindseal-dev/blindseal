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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runLayer0, makeLayer0Result } from '../detection/layer0-decoder.js';
import { runLayer1 } from '../detection/layer1-heuristics.js';
import { BindError, GATED_TRANSFER_DISC, TRANSFER_GATE_ID, actionFromPayload, checkActionBinding, type BoundAction } from '../chain/action-binding.js';
import { openAudit } from '@blindseal/audit';
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
Only clean verdicts are attested. The decision is appended to the hash-chained audit log first.
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
  const entry = audit.chain.append({ decisionId, verdict, payloadHash });
  process.stdout.write(`decision ${decisionId}: ${verdict} (audit #${entry.index} ${entry.hash.slice(0, 18)}…)\n`);
  if (verdict !== 'clean') {
    process.stderr.write(`blindseal attest: verdict is ${verdict} (${result.detectedPatterns.join(', ')}); no attestation for a non-clean call\n`);
    return 1;
  }

  // 3) the on-chain action the gated program will execute: `action`, checked against the payload above
  // 4) prove
  const tmpPayload = path.join(os.tmpdir(), `blindseal-payload-${decisionId}.json`);
  writeFileSync(tmpPayload, payload);
  const args = [
    '--payload', tmpPayload, '--out', o.out, '--decision-id', decisionId,
    '--chain-id', String(action.chainId),
    '--target-program', action.targetProgram, '--source-authority', action.sourceAuthority,
    '--recipient', action.recipient, '--mint', action.mint === NATIVE_MINT_B58 ? '' : action.mint, '--amount', action.amount,
    '--instruction', action.instruction, '--expiry', expiry,
  ];
  process.stdout.write(`proving (this takes a while on CPU)…\n`);
  const t0 = Date.now();
  const r = spawnSync(prover, args, { stdio: 'inherit' });
  if (r.status !== 0) { process.stderr.write(`blindseal attest: prover exited ${r.status}\n`); return 1; }
  recordProofSeconds((Date.now() - t0) / 1000);
  process.stdout.write(`attestation written: ${o.out} (decision ${decisionId}, payloadHash ${payloadHash}, expirySlot ${expiry}${expiry === NO_EXPIRY_SLOT ? ' = no expiry' : ''})\n`);
  return 0;
}
