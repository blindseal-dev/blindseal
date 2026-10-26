/// `blindseal attest` — a REAL screened decision → a Groth16 attestation (BLINDSEAL.md §3.2/§3.3).
///
/// 1. Screens the tool call with the proven layers (L0 decode-then-L1, L1 heuristics) — the same
///    code the proxy runs. A non-clean verdict stops here: there is no proof for a blocked call.
/// 2. Appends the decision to the hash-chained audit log (~/.blindseal/audit.log): content-free,
///    just decisionId / verdict / payloadHash. That entry is the decision the attestation names.
/// 3. Parses the on-chain action from the call (chain/solana.ts) and binds the gated program's
///    exact transfer: target program, instruction discriminator, source authority, recipient,
///    native mint, amount.
/// 4. Runs the local prover (crates/prover) with that payload + action → attestation.json.
///
/// Usage:
///   blindseal attest <toolcall.json> --out <attestation.json> --target-program <id>
///     [--instruction <16 hex>] [--expiry <slot> | --no-expiry] [--prover <path>] [--audit-dir <dir>]
///   expiry defaults to the current mainnet slot + 1500 (fetched over RPC); the prover binary is
///   resolved by src/prover/resolve.ts (--prover, $BLINDSEAL_PROVER, ~/.blindseal/bin, download).
///   toolcall.json: { "toolName": "transfer_sol", "args": { "to": "...", "lamports": 1000000, "from": "..." } }
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runLayer0, makeLayer0Result } from '../detection/layer0-decoder.js';
import { runLayer1 } from '../detection/layer1-heuristics.js';
import { parseSolanaAction } from '../chain/solana.js';
import { openAudit } from '@blindseal/audit';
import { rpcUrl } from '@blindseal/chain-reads';
import { ProverUnavailableError, resolveProver } from '../prover/resolve.js';

const HELP = `blindseal attest — screen a tool call, record the decision, prove it

Usage:
  blindseal attest <toolcall.json> --out <attestation.json> --target-program <program id> [flags]

Flags
  --out <file>               where to write attestation.json (default ./attestation.json)
  --target-program <id>      the gated program the action targets (base58)
  --instruction <16 hex>     instruction discriminator (default: transfer-gate gated_transfer)
  --expiry <slot>            expirySlot (default: current slot + 1500, fetched from the RPC)
  --no-expiry                write the "no expiry" sentinel (2000000000) instead of fetching a slot
  --prover <path>            prover binary (default: $BLINDSEAL_PROVER, then ~/.blindseal/bin/,
                             downloaded from the GitHub release on first use)
  --audit-dir <dir>          audit base dir (default ~/.blindseal)
  --help, -h                 this help

Only clean verdicts are attested. The decision is appended to the hash-chained audit log first.
RPC for the slot: $BLINDSEAL_RPC_URL, else the public mainnet endpoint.
`;

// sha256("global:gated_transfer")[..8] — transfer-gate's Anchor discriminator.
const GATED_TRANSFER_DISC = '0x981894646560fc2b';
/// The "no expiry" sentinel the circuit accepts (--no-expiry).
export const NO_EXPIRY_SLOT = '2000000000';
/// Default validity window: current slot + this many slots (~10 minutes at 400ms/slot).
export const EXPIRY_WINDOW_SLOTS = 1500;

interface Opts {
  file?: string;
  out: string;
  targetProgram?: string;
  instruction: string;
  expiry?: string;
  noExpiry: boolean;
  prover?: string;
  auditDir: string;
  help?: boolean;
}

function parse(argv: string[]): Opts {
  const o: Opts = { out: 'attestation.json', instruction: GATED_TRANSFER_DISC, noExpiry: false, auditDir: path.join(os.homedir(), '.blindseal') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--out') o.out = argv[++i]!;
    else if (a === '--target-program') o.targetProgram = argv[++i];
    else if (a === '--instruction') o.instruction = argv[++i]!;
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
  if (!o.targetProgram) { process.stderr.write('blindseal attest: --target-program is required\n'); return 2; }

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
  try {
    expiry = await resolveExpiry(o);
  } catch (e) {
    process.stderr.write(`blindseal attest: ${(e as Error).message}\n`);
    return 1;
  }

  // The payload the proof commits to: the canonical tool-call JSON exactly as screened.
  const raw = readFileSync(o.file, 'utf8');
  const call = JSON.parse(raw) as { toolName: string; args: unknown };
  const payload = JSON.stringify({ tool: call.toolName, args: call.args });
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

  // 3) the on-chain action the gated program will execute
  const action = parseSolanaAction(call.toolName, call.args);
  if (!action) { process.stderr.write('blindseal attest: the call is not a recognizable on-chain action\n'); return 1; }
  if (!action.recipient || !action.amount || !action.sourceAuthority) {
    process.stderr.write('blindseal attest: action needs recipient, amount and source authority\n');
    return 1;
  }

  // 4) prove
  const tmpPayload = path.join(os.tmpdir(), `blindseal-payload-${decisionId}.json`);
  writeFileSync(tmpPayload, payload);
  const args = [
    '--payload', tmpPayload, '--out', o.out, '--decision-id', decisionId,
    '--chain-id', String(action.chainId),
    '--target-program', o.targetProgram, '--source-authority', action.sourceAuthority,
    '--recipient', action.recipient, '--mint', action.mint, '--amount', action.amount,
    '--instruction', o.instruction, '--expiry', expiry,
  ];
  process.stdout.write(`proving (this takes a while on CPU)…\n`);
  const r = spawnSync(prover, args, { stdio: 'inherit' });
  if (r.status !== 0) { process.stderr.write(`blindseal attest: prover exited ${r.status}\n`); return 1; }
  process.stdout.write(`attestation written: ${o.out} (decision ${decisionId}, payloadHash ${payloadHash}, expirySlot ${expiry}${expiry === NO_EXPIRY_SLOT ? ' = no expiry' : ''})\n`);
  return 0;
}
