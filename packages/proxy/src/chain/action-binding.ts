/// Payload → action binding (release 0.7.0) — the TypeScript mirror of
/// crates/detector-core/src/action_binding.rs, which the SP1 guest runs before hashing: the screened
/// payload (`{"tool", "args"}` exactly as `blindseal attest` serializes it) must parse to the on-chain
/// action the proof binds. `blindseal attest` runs this first and refuses a mismatch before it starts
/// the prover; the guest asserts the same rule, so a proof for a mismatched pair cannot exist.
/// Both implementations run the shared vectors in evals/vectors/action-binding.json.
///
/// The field keys and the transfer-tool pattern are the Solana adapter's (chain/solana.ts). Defaults:
/// target program = transfer-gate, instruction = its `gated_transfer` discriminator, mint = native.
/// The full rule is documented in the Rust module header.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  AMOUNT_KEYS, AUTHORITY_KEYS, CHAIN_ID_SOLANA_MAINNET, MINT_KEYS, PROGRAM_KEYS, RECIPIENT_KEYS, TRANSFER_TOOL,
} from './solana.js';

export const TRANSFER_GATE_ID = '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa';
/// sha256("global:gated_transfer")[..8]
export const GATED_TRANSFER_DISC = '0x981894646560fc2b';
const NATIVE_MINT = PublicKey.default.toBase58(); // 32 zero bytes = native SOL

export type BindErrorCode =
  | 'unparseable' | 'not-an-action'
  | 'missing-recipient' | 'missing-amount' | 'missing-source-authority'
  | 'bad-recipient' | 'bad-amount' | 'bad-mint' | 'bad-source-authority' | 'bad-program'
  | 'chain-id-mismatch' | 'target-program-mismatch' | 'instruction-mismatch'
  | 'source-authority-mismatch' | 'recipient-mismatch' | 'mint-mismatch' | 'amount-mismatch';

export class BindError extends Error {
  constructor(public readonly code: BindErrorCode) { super(`payload/action binding: ${code}`); }
}

/// The action a payload binds. Pubkeys base58 (mint = 32 zero bytes for native SOL), instruction as
/// 0x + 16 hex, amount as a decimal string.
export interface BoundAction {
  chainId: number;
  targetProgram: string;
  instruction: string;
  sourceAuthority: string;
  recipient: string;
  mint: string;
  amount: string;
}

type Picked = { kind: 'str'; v: string } | { kind: 'num'; v: number };

/// The adapter's firstString, keeping the value's JSON type.
function pick(obj: Record<string, unknown>, keys: readonly string[]): Picked | undefined {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return { kind: 'str', v };
    if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'num', v };
  }
  return undefined;
}

function pubkey(p: Picked, code: BindErrorCode): string {
  if (p.kind !== 'str') throw new BindError(code);
  try { return new PublicKey(p.v).toBase58(); } catch { throw new BindError(code); }
}

const U64_MAX = (1n << 64n) - 1n;
function amount(p: Picked): string {
  if (p.kind === 'str') {
    if (!/^[0-9]+$/.test(p.v) || BigInt(p.v) > U64_MAX) throw new BindError('bad-amount');
    return BigInt(p.v).toString();
  }
  // integral, 0 ≤ v ≤ 2^53−1 (1e3 and 1.0 are integers; -0 is 0) — the Rust side accepts the same set
  if (!Number.isSafeInteger(p.v) || p.v < 0) throw new BindError('bad-amount');
  return String(p.v === 0 ? 0 : p.v);
}

/// `instruction` / `method` value → 0x + 16 hex: 16 hex digits taken as-is, else the Anchor
/// discriminator sha256("global:" + name)[..8].
export function instructionHex(s: string): string {
  const h = s.replace(/^0[xX]/, '');
  if (/^[0-9a-fA-F]{16}$/.test(h)) return '0x' + h.toLowerCase();
  return '0x' + createHash('sha256').update('global:' + s).digest('hex').slice(0, 16);
}

/// JSON.parse accepts three things serde_json (the guest's parser) refuses: numbers that overflow to
/// ±Infinity, strings or keys with a lone UTF-16 surrogate, and nesting of 128 or more containers. Refuse them
/// here too so both sides agree on every payload.
const MAX_DEPTH = 127; // serde_json's recursion limit: 127 nested containers parse, 128 do not
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
function serdeAccepts(v: unknown, depth: number): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return wellFormed(v);
  if (v === null || typeof v !== 'object') return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => serdeAccepts(x, depth + 1));
  return Object.entries(v).every(([k, x]) => wellFormed(k) && serdeAccepts(x, depth + 1));
}

/// Parse the screened payload into the action it binds, or throw BindError.
export function actionFromPayload(payload: string): BoundAction {
  let top: unknown;
  try { top = JSON.parse(payload); } catch { throw new BindError('unparseable'); }
  if (!serdeAccepts(top, 0)) throw new BindError('unparseable');
  if (!top || typeof top !== 'object' || Array.isArray(top)) throw new BindError('unparseable');
  const t = top as Record<string, unknown>;
  if (Object.keys(t).length !== 2) throw new BindError('unparseable');
  const tool = t.tool;
  const args = t.args;
  if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new BindError('unparseable');
  const a = args as Record<string, unknown>;

  const explicitProgram = pick(a, PROGRAM_KEYS);
  if (!TRANSFER_TOOL.test(tool) && !explicitProgram) throw new BindError('not-an-action');
  const r = pick(a, RECIPIENT_KEYS); if (!r) throw new BindError('missing-recipient');
  const am = pick(a, AMOUNT_KEYS); if (!am) throw new BindError('missing-amount');
  const s = pick(a, AUTHORITY_KEYS); if (!s) throw new BindError('missing-source-authority');
  const recipient = pubkey(r, 'bad-recipient');
  const amt = amount(am);
  const sourceAuthority = pubkey(s, 'bad-source-authority');
  const m = pick(a, MINT_KEYS);
  const mint = m ? pubkey(m, 'bad-mint') : NATIVE_MINT;
  const targetProgram = explicitProgram ? pubkey(explicitProgram, 'bad-program') : TRANSFER_GATE_ID;
  const ixName = [a.instruction, a.method].find((v): v is string => typeof v === 'string' && v.length > 0);
  const instruction = ixName !== undefined ? instructionHex(ixName) : GATED_TRANSFER_DISC;
  return { chainId: CHAIN_ID_SOLANA_MAINNET, targetProgram, instruction, sourceAuthority, recipient, mint, amount: amt };
}

/// The action the prover will be handed. Pubkeys may be '' for n/a (mint '' = native), amount may be
/// a number, instruction any case with or without 0x.
export interface ActionInput {
  chainId: number;
  targetProgram: string;
  instruction: string;
  sourceAuthority: string;
  recipient: string;
  mint: string;
  amount: string | number | bigint;
}

const norm32 = (s: string): string => { try { return s === '' ? NATIVE_MINT : new PublicKey(s).toBase58(); } catch { return `invalid:${s}`; } };
const normIx = (s: string): string => '0x' + s.replace(/^0[xX]/, '').toLowerCase();

/// Throws BindError on the first differing field, in the guest's order.
export function checkActionBinding(payload: string, action: ActionInput): BoundAction {
  const p = actionFromPayload(payload);
  if (p.chainId !== action.chainId) throw new BindError('chain-id-mismatch');
  if (p.targetProgram !== norm32(action.targetProgram)) throw new BindError('target-program-mismatch');
  if (p.instruction !== normIx(action.instruction)) throw new BindError('instruction-mismatch');
  if (p.sourceAuthority !== norm32(action.sourceAuthority)) throw new BindError('source-authority-mismatch');
  if (p.recipient !== norm32(action.recipient)) throw new BindError('recipient-mismatch');
  if (p.mint !== norm32(action.mint)) throw new BindError('mint-mismatch');
  let amt: bigint | undefined;
  try { amt = BigInt(action.amount); } catch { amt = undefined; }
  if (amt === undefined || BigInt(p.amount) !== amt) throw new BindError('amount-mismatch');
  return p;
}
