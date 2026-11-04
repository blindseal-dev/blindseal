// The one check a Blindseal consumer runs before it acts on an attestation, in this order:
//   1. parse        — base64 or JSON text, or an object, into the attestation.json shape
//   2. proof        — blindseal-sdk verifyOffchain: Groth16 + labels + action binding (actionHash and
//                     nullifier recomputed from the file's action fields over the committed inputs)
//   3. action       — the attestation's action is EXACTLY the transfer about to happen (first
//                     differing field is named: chainId, targetProgram, instruction, sourceAuthority,
//                     recipient, mint, amount)
//   4. expiry       — the committed expirySlot is not behind the chain's current slot
//   5. nullifier    — the Nullifier PDA does not exist (unconsumed); it is created by blindseal-verify
//                     when a gated program consumes the attestation
// Steps 4 and 5 read the chain through an injected `ChainReader` so callers (and tests) decide what
// the chain says; a reader that throws fails the check closed (`chain_unavailable`).
// What this does NOT prove: that the proof will be accepted on chain by a particular gated program
// (its policy allowlist, vkey allowlist and pause switch live in the verifier's Config), and nothing
// about the agent's intent beyond the screened payload.
import { Connection, PublicKey } from '@solana/web3.js';
import {
  CHAIN_ID_SOLANA_MAINNET, PROGRAM_ID, decodePublicInputs, hex, nullifierPda, verifyOffchain,
  type Attestation,
} from 'blindseal-sdk';

export type { Attestation } from 'blindseal-sdk';

/** The transfer a consumer is about to execute, as the attestation must describe it. */
export interface ExpectedAction {
  /** base58: the authority the transfer debits (the signer). */
  sourceAuthority: string;
  /** base58: who is paid — for SPL transfers the OWNER of the destination token account. */
  recipient: string;
  /** base58 mint, or '' for native SOL. */
  mint: string;
  /** Atomic units (lamports or token base units). */
  amount: bigint | number | string;
  /** When the consumer knows which program will consume the attestation on chain. */
  targetProgram?: string;
  /** 0x + 16 hex: that program's instruction discriminator. */
  instruction?: string;
  /** Default 1 (Solana mainnet); the only chain id Blindseal currently issues. */
  chainId?: number;
}

export type ActionField = 'chainId' | 'targetProgram' | 'instruction' | 'sourceAuthority' | 'recipient' | 'mint' | 'amount';
/** Comparison order; `actionMismatch` names the FIRST differing field in this order. */
export const ACTION_FIELDS: readonly ActionField[] = ['chainId', 'targetProgram', 'instruction', 'sourceAuthority', 'recipient', 'mint', 'amount'];

export interface AccountSnapshot { owner: PublicKey; data: Uint8Array }
/** The two reads the check needs. Inject a real one (`connectionReader`, `rpcReader`) or a fake. */
export interface ChainReader {
  getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null>;
  getSlot(): Promise<number>;
}

export type CheckCode = 'malformed' | 'invalid_proof' | 'action_mismatch' | 'expired' | 'consumed' | 'chain_unavailable';

export interface CheckOk {
  ok: true;
  attestation: Attestation;
  /** 0x hex, from the committed public inputs. */
  nullifier: string;
  /** The Nullifier PDA that will exist once the attestation is consumed. */
  nullifierPda: PublicKey;
  expirySlot: bigint;
  currentSlot: number;
}
export interface CheckFail {
  ok: false;
  code: CheckCode;
  /** One sentence, safe to return to a caller. */
  reason: string;
  /** For `action_mismatch`: the first field that differs. */
  field?: ActionField;
  attestation?: Attestation;
}
export type CheckResult = CheckOk | CheckFail;

export interface CheckOptions {
  /** The verifier program whose Nullifier PDAs are read (default: the mainnet program). */
  verifyProgramId?: PublicKey;
}

/** Thrown by consumers that refuse; carries the structured failure. */
export class AttestationRefusedError extends Error {
  constructor(public readonly result: CheckFail) {
    super(`blindseal: ${result.code}${result.field ? ` (${result.field})` : ''}: ${result.reason}`);
    this.name = 'AttestationRefusedError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Accept an attestation as the header carries it (base64 of attestation.json), as JSON text, or as an
 * already-parsed object. Only the shape is checked here (the fields the proof and action checks need);
 * values are checked by `verifyOffchain`. Throws with a plain message on anything else.
 */
export function parseAttestation(input: unknown): Attestation {
  let v: unknown = input;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) throw new Error('attestation is empty');
    if (s.startsWith('{')) {
      v = JSON.parse(s);
    } else {
      if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) throw new Error('attestation is neither JSON nor base64');
      const text = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      try { v = JSON.parse(text); } catch { throw new Error('attestation base64 does not decode to JSON'); }
    }
  }
  if (!isRecord(v)) throw new Error('attestation must be a JSON object');
  const pi = v.publicInputs;
  if (!Array.isArray(pi) || typeof pi[0] !== 'string') throw new Error('attestation.publicInputs[0] is missing');
  if (!isRecord(v.proof) || typeof v.proof.bytes !== 'string') throw new Error('attestation.proof.bytes is missing');
  if (!isRecord(v.action)) throw new Error('attestation.action is missing');
  if (typeof v.nonce !== 'string') throw new Error('attestation.nonce is missing');
  if (typeof v.chainId !== 'number') throw new Error('attestation.chainId is missing');
  return v as unknown as Attestation;
}

/** Canonical base58 for comparison; '' (none / native) stays ''. Throws on a malformed key. */
const canonKey = (s: string | undefined | null): string => {
  const v = (s ?? '').trim();
  if (!v) return '';
  const k = new PublicKey(v);
  return k.equals(PublicKey.default) ? '' : k.toBase58();
};
const canonHex = (s: string | undefined | null): string => '0x' + String(s ?? '').trim().replace(/^0x/i, '').toLowerCase();
const toAmount = (v: bigint | number | string): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 0) throw new Error(`amount ${v} is not a non-negative safe integer`); return BigInt(v); }
  if (!/^\d+$/.test(v.trim())) throw new Error(`amount ${JSON.stringify(v)} is not a decimal integer`);
  return BigInt(v.trim());
};

export interface Mismatch { field: ActionField; expected: string; got: string }

/**
 * Compare the attestation's action to the transfer the consumer is about to make. Returns the FIRST
 * differing field (in `ACTION_FIELDS` order) or null when they agree. Keys are compared canonically
 * (a zero key equals ''), hex case-insensitively, amounts as integers. A malformed value on either
 * side is reported as a mismatch of that field rather than thrown.
 */
export function actionMismatch(att: Attestation, expected: ExpectedAction): Mismatch | null {
  const a = att.action;
  const pairs: Array<[ActionField, () => string, () => string]> = [
    ['chainId', () => String(att.chainId), () => String(expected.chainId ?? CHAIN_ID_SOLANA_MAINNET)],
    ['targetProgram', () => canonKey(a.targetProgram), () => canonKey(expected.targetProgram)],
    ['instruction', () => canonHex(a.instruction), () => canonHex(expected.instruction)],
    ['sourceAuthority', () => canonKey(a.sourceAuthority), () => canonKey(expected.sourceAuthority)],
    ['recipient', () => canonKey(a.recipient), () => canonKey(expected.recipient)],
    ['mint', () => canonKey(a.mint), () => canonKey(expected.mint)],
    ['amount', () => toAmount(a.amount).toString(), () => toAmount(expected.amount).toString()],
  ];
  for (const [field, got, want] of pairs) {
    // targetProgram / instruction are compared only when the consumer states them
    if (field === 'targetProgram' && expected.targetProgram === undefined) continue;
    if (field === 'instruction' && expected.instruction === undefined) continue;
    let g: string; let w: string;
    try { g = got(); } catch (e) { return { field, expected: safe(want), got: `malformed (${(e as Error).message})` }; }
    try { w = want(); } catch (e) { return { field, expected: `malformed (${(e as Error).message})`, got: g }; }
    if (g !== w) return { field, expected: w, got: g };
  }
  return null;
}
const safe = (f: () => string): string => { try { return f(); } catch { return '?'; } };

/** The committed nullifier (0x hex) and its PDA. Throws if the blob does not decode. */
export function nullifierOf(att: Attestation, verifyProgramId = PROGRAM_ID): { nullifier: string; pda: PublicKey; expirySlot: bigint } {
  const d = decodePublicInputs(hex(att.publicInputs[0]));
  return { nullifier: '0x' + d.nullifier.toString('hex'), pda: nullifierPda(d.nullifier, verifyProgramId), expirySlot: d.expirySlot };
}

/** Nullifier record size written by blindseal-verify (8 disc ‖ u64 slot ‖ 32 consumer ‖ 32 actionHash ‖ u8 bump). */
export const NULLIFIER_ACCOUNT_LEN = 81;

/** Is this attestation's nullifier consumed? An account at the PDA owned by the verifier means yes. */
export async function isConsumed(att: Attestation, chain: ChainReader, verifyProgramId = PROGRAM_ID): Promise<boolean> {
  const { pda } = nullifierOf(att, verifyProgramId);
  const info = await chain.getAccountInfo(pda);
  return info !== null && info.owner.equals(verifyProgramId) && info.data.length >= NULLIFIER_ACCOUNT_LEN;
}

/** Run the whole check. Never throws for a bad attestation; only a programming error (bad options) can. */
export async function checkAttestation(input: unknown, expected: ExpectedAction, chain: ChainReader, opts: CheckOptions = {}): Promise<CheckResult> {
  const verifyProgramId = opts.verifyProgramId ?? PROGRAM_ID;
  let att: Attestation;
  try { att = parseAttestation(input); } catch (e) { return { ok: false, code: 'malformed', reason: (e as Error).message }; }

  // 2. proof + labels + action binding (off chain, no RPC)
  let proof;
  try { proof = await verifyOffchain(att); } catch (e) { return { ok: false, code: 'invalid_proof', reason: `verifier failed: ${(e as Error).message}`, attestation: att }; }
  if (!proof.ok) return { ok: false, code: 'invalid_proof', reason: proof.reason ?? 'proof did not verify', attestation: att };

  // 3. the action is this transfer
  const mm = actionMismatch(att, expected);
  if (mm) return { ok: false, code: 'action_mismatch', field: mm.field, reason: `attestation ${mm.field} is ${mm.got || '(none)'}, the transfer's is ${mm.expected || '(none)'}`, attestation: att };

  // 4. expiry against the chain's current slot
  const { nullifier, pda, expirySlot } = nullifierOf(att, verifyProgramId);
  let slot: number;
  try { slot = await chain.getSlot(); } catch (e) { return { ok: false, code: 'chain_unavailable', reason: `could not read the current slot: ${(e as Error).message}`, attestation: att }; }
  if (expirySlot < BigInt(slot)) return { ok: false, code: 'expired', reason: `attestation expired at slot ${expirySlot}, the chain is at ${slot}`, attestation: att };

  // 5. not consumed
  let consumed: boolean;
  try { consumed = await isConsumed(att, chain, verifyProgramId); } catch (e) { return { ok: false, code: 'chain_unavailable', reason: `could not read the nullifier account: ${(e as Error).message}`, attestation: att }; }
  if (consumed) return { ok: false, code: 'consumed', reason: `nullifier ${nullifier} is already consumed (replay)`, attestation: att };

  return { ok: true, attestation: att, nullifier, nullifierPda: pda, expirySlot, currentSlot: slot };
}

/** A ChainReader over a web3.js Connection. */
export function connectionReader(conn: Connection, commitment: 'confirmed' | 'finalized' = 'confirmed'): ChainReader {
  return {
    async getAccountInfo(address) {
      const info = await conn.getAccountInfo(address, commitment);
      return info ? { owner: info.owner, data: new Uint8Array(info.data) } : null;
    },
    getSlot: () => conn.getSlot(commitment),
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A dependency-free ChainReader: JSON-RPC over fetch (pass a fake `fetchImpl` in tests). */
export function rpcReader(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, commitment: 'confirmed' | 'finalized' = 'confirmed'): ChainReader {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? 'error'}`);
    return j.result as T;
  };
  return {
    async getAccountInfo(address) {
      const r = await call<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address.toBase58(), { encoding: 'base64', commitment }]);
      const v = r?.value;
      if (!v) return null;
      return { owner: new PublicKey(v.owner), data: new Uint8Array(Buffer.from(v.data[0], 'base64')) };
    },
    getSlot: () => call<number>('getSlot', [{ commitment }]),
  };
}
