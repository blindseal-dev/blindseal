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
///     [--instruction <16 hex>] [--expiry <slot>] [--prover <path>] [--audit-dir <dir>]
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

const HELP = `blindseal attest — screen a tool call, record the decision, prove it

Usage:
  blindseal attest <toolcall.json> --out <attestation.json> --target-program <program id> [flags]

Flags
  --out <file>               where to write attestation.json (default ./attestation.json)
  --target-program <id>      the gated program the action targets (base58)
  --instruction <16 hex>     instruction discriminator (default: transfer-gate gated_transfer)
  --expiry <slot>            expirySlot (default 2000000000)
  --prover <path>            prover binary (default crates/prover/target/release/blindseal-prover)
  --audit-dir <dir>          audit base dir (default ~/.blindseal)
  --help, -h                 this help

Only clean verdicts are attested. The decision is appended to the hash-chained audit log first.
`;

// sha256("global:gated_transfer")[..8] — transfer-gate's Anchor discriminator.
const GATED_TRANSFER_DISC = '0x981894646560fc2b';

interface Opts {
  file?: string;
  out: string;
  targetProgram?: string;
  instruction: string;
  expiry: string;
  prover?: string;
  auditDir: string;
  help?: boolean;
}

function parse(argv: string[]): Opts {
  const o: Opts = { out: 'attestation.json', instruction: GATED_TRANSFER_DISC, expiry: '2000000000', auditDir: path.join(os.homedir(), '.blindseal') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--out') o.out = argv[++i]!;
    else if (a === '--target-program') o.targetProgram = argv[++i];
    else if (a === '--instruction') o.instruction = argv[++i]!;
    else if (a === '--expiry') o.expiry = argv[++i]!;
    else if (a === '--prover') o.prover = argv[++i];
    else if (a === '--audit-dir') o.auditDir = argv[++i]!;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else o.file = a;
  }
  return o;
}

function findProver(explicit?: string): string {
  if (explicit) return explicit;
  let dir = process.cwd();
  for (let i = 0; i < 7; i++) {
    const c = path.join(dir, 'crates/prover/target/release/blindseal-prover');
    if (existsSync(c)) return c;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('prover binary not found; build crates/prover or pass --prover');
}

export async function runAttestCli(argv: string[]): Promise<number> {
  let o: Opts;
  try { o = parse(argv); } catch (e) { process.stderr.write(`blindseal attest: ${(e as Error).message}\n${HELP}`); return 2; }
  if (o.help || !o.file) { process.stdout.write(HELP); return o.help ? 0 : 2; }
  if (!o.targetProgram) { process.stderr.write('blindseal attest: --target-program is required\n'); return 2; }

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
  const prover = findProver(o.prover);
  const tmpPayload = path.join(os.tmpdir(), `blindseal-payload-${decisionId}.json`);
  writeFileSync(tmpPayload, payload);
  const args = [
    '--payload', tmpPayload, '--out', o.out, '--decision-id', decisionId,
    '--chain-id', String(action.chainId),
    '--target-program', o.targetProgram, '--source-authority', action.sourceAuthority,
    '--recipient', action.recipient, '--mint', action.mint, '--amount', action.amount,
    '--instruction', o.instruction, '--expiry', o.expiry,
  ];
  process.stdout.write(`proving (this takes a while on CPU)…\n`);
  const r = spawnSync(prover, args, { stdio: 'inherit' });
  if (r.status !== 0) { process.stderr.write(`blindseal attest: prover exited ${r.status}\n`); return 1; }
  process.stdout.write(`attestation written: ${o.out} (decision ${decisionId}, payloadHash ${payloadHash})\n`);
  return 0;
}
