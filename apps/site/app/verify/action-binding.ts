// Step 4 of the verify page: the action fields in the file are labels; the proof commits to the action
// only through actionHash (and to the nullifier as sha256 over it). Recompute both in the browser —
// byte-for-byte packages/sdk/src/ix.ts `computeActionHash` / `computeNullifier` and the Rust guest —
// over the COMMITTED public inputs, and compare. WebCrypto only; nothing leaves the tab.
import { pubkeyBytes } from './base58';
import type { AttestationDoc, Decoded } from './verifier';

export const ACTION_DOMAIN = 'blindseal.action.v1';
export const NULLIFIER_DOMAIN = 'blindseal.nullifier.v1';

export interface ActionBindingCheck {
  /** false when the file has no `action` object: nothing to recompute. */
  checked: boolean;
  actionHash?: string;   // recomputed from the action fields + nonce over the committed inputs
  nullifier?: string;    // derived from the committed actionHash
  mismatches: ('actionHash' | 'nullifier')[];
  /** the action fields could not be hashed (missing nonce, malformed key, hex or amount) */
  error?: string;
  /** one sentence per problem, for the checklist */
  reasons: string[];
}

const HEX = (re: RegExp) => (v: unknown) => typeof v === 'string' && re.test(v);
const isHex64 = HEX(/^(0x)?[0-9a-f]{64}$/i), isHex16 = HEX(/^(0x)?[0-9a-f]{16}$/i);
const U64_MAX = (1n << 64n) - 1n;

const hexBytes = (s: string): Uint8Array => {
  const h = s.replace(/^0x/i, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const u16le = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]);
const u64le = (n: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; };
const utf8 = (s: string) => new TextEncoder().encode(s);
const hx = (b: ArrayBuffer | Uint8Array) => '0x' + Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const sha256 = async (b: Uint8Array) => hx(await crypto.subtle.digest('SHA-256', b));

type Action = { targetProgram?: unknown; sourceAuthority?: unknown; instruction?: unknown; recipient?: unknown; mint?: unknown; amount?: unknown };

/** The preimage of actionHash, validated field by field (throws with the field named). */
function actionPreimage(doc: AttestationDoc, dec: Decoded): Uint8Array {
  const a = doc.action as Action;
  const chainId = doc.chainId;
  if (!Number.isInteger(chainId) || (chainId as number) < 0 || (chainId as number) > 0xffff) throw new Error('chainId must be a u16');
  if (!isHex64(doc.nonce)) throw new Error('nonce must be 32 bytes of hex');
  if (!isHex16(a.instruction)) throw new Error('action.instruction must be 8 bytes of hex');
  if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount) || BigInt(a.amount) > U64_MAX) throw new Error('action.amount must be a decimal u64 string');
  const key = (k: 'targetProgram' | 'sourceAuthority' | 'recipient' | 'mint') => {
    const v = a[k];
    if (typeof v !== 'string') throw new Error(`action.${k} must be a base58 string ('' for none)`);
    try { return pubkeyBytes(v); } catch { throw new Error(`action.${k} is not a valid public key`); }
  };
  return concat([
    utf8(ACTION_DOMAIN), u16le(chainId as number),
    key('targetProgram'), key('sourceAuthority'), hexBytes(a.instruction as string),
    key('recipient'), key('mint'), u64le(BigInt(a.amount)),
    hexBytes(dec.payloadHash), hexBytes(dec.policyRoot), hexBytes(dec.detectorVersion), u64le(BigInt(dec.expirySlot)), hexBytes(doc.nonce as string),
  ]);
}

export async function checkActionBinding(doc: AttestationDoc, dec: Decoded): Promise<ActionBindingCheck> {
  if (doc.action === undefined || doc.action === null) return { checked: false, mismatches: [], reasons: [] };
  const out: ActionBindingCheck = { checked: true, mismatches: [], reasons: [] };
  if (typeof doc.action !== 'object') out.error = 'action must be an object';
  else {
    try { out.actionHash = await sha256(actionPreimage(doc, dec)); } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
  }
  out.nullifier = await sha256(concat([utf8(NULLIFIER_DOMAIN), hexBytes(dec.actionHash)]));
  if (out.error) out.reasons.push('action fields unusable: ' + out.error);
  if (out.actionHash !== undefined && out.actionHash !== dec.actionHash) { out.mismatches.push('actionHash'); out.reasons.push('the file’s action fields hash to ' + out.actionHash.slice(0, 10) + '…, not the proof’s action hash ' + dec.actionHash.slice(0, 10) + '…'); }
  if (out.nullifier !== dec.nullifier) { out.mismatches.push('nullifier'); out.reasons.push('the proof’s nullifier does not derive from its action hash'); }
  return out;
}
