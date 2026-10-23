// Server-side canonical hashing for the "What binds it" demo (BLINDSEAL.md §3.3), byte-for-byte
// packages/sdk/src/ix.ts `computeActionHash` / `computeNullifier` (the SDK is TypeScript source
// outside this app and is not in its transpilePackages, so the layout is mirrored here on
// node:crypto; page.tsx asserts the result against the attestation's recorded actionHash and
// nullifier at render time, so any drift from the SDK fails the page, never shows a wrong hash).
import { createHash } from 'node:crypto';

export const ACTION_DOMAIN = 'blindseal.action.v1';
export const NULLIFIER_DOMAIN = 'blindseal.nullifier.v1';

export interface Action { targetProgram: string; sourceAuthority: string; instruction: string; recipient: string; mint: string; amount: string; }
export interface ActionInputs { chainId: number; action: Action; payloadHash: string; policyRoot: string; detectorVersion: string; expirySlot: number; nonce: string; }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 → 32 bytes ('' = the zero key, as PublicKey.default in the SDK). */
export function pubkeyBytes(s: string): Buffer {
  if (!s) return Buffer.alloc(32);
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`not base58: ${s}`); n = n * 58n + BigInt(i); }
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0; for (const c of s) { if (c !== '1') break; zeros++; }
  const out = Buffer.concat([Buffer.alloc(zeros), Buffer.from(body)]);
  if (out.length !== 32) throw new Error(`pubkey ${s} is ${out.length} bytes, not 32`);
  return out;
}
export const hex = (s: string): Buffer => Buffer.from(s.replace(/^0x/, ''), 'hex');
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const hx = (b: Buffer) => '0x' + b.toString('hex');

export function actionHash(i: ActionInputs): string {
  const a = i.action;
  const instruction = hex(a.instruction);
  if (instruction.length !== 8) throw new Error('instruction must be 8 bytes');
  const nonce = hex(i.nonce);
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  return hx(createHash('sha256')
    .update(ACTION_DOMAIN).update(u16le(i.chainId))
    .update(pubkeyBytes(a.targetProgram)).update(pubkeyBytes(a.sourceAuthority)).update(instruction)
    .update(pubkeyBytes(a.recipient)).update(pubkeyBytes(a.mint)).update(u64le(BigInt(a.amount)))
    .update(hex(i.payloadHash)).update(hex(i.policyRoot)).update(hex(i.detectorVersion)).update(u64le(BigInt(i.expirySlot))).update(nonce)
    .digest());
}
export const nullifierOf = (actionHashHex: string): string => hx(createHash('sha256').update(NULLIFIER_DOMAIN).update(hex(actionHashHex)).digest());
/** payloadHash = sha256(payload_bytes), payload_bytes = JSON.stringify({ tool, args }) as `blindseal attest` screens it (no domain prefix in v1). */
export const sha256Hex = (s: string): string => hx(createHash('sha256').update(s).digest());
