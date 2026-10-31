// base58 → 32-byte public key, with no dependency (shared by the server-side action-hash demo and the
// in-browser action-binding check). '' is the zero key, as PublicKey.default in the SDK.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function pubkeyBytes(s: string): Uint8Array {
  if (!s) return new Uint8Array(32);
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`not base58: ${s}`); n = n * 58n + BigInt(i); }
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0; for (const c of s) { if (c !== '1') break; zeros++; }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  if (out.length !== 32) throw new Error(`pubkey ${s} is ${out.length} bytes, not 32`);
  return out;
}
