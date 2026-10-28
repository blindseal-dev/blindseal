// Browser-side disclosure verification, byte-for-byte the audit package's
// verifyDisclosure: canonical (sorted-key) JSON, sha256 domain-separated entry hashes, in-window
// prevHash links, and an ed25519 signature over the canonical window by the stated signer.
// WebCrypto only; nothing is uploaded. Ed25519 in WebCrypto needs a current browser.
import { CLEAN_VERDICT } from './verdict';
export interface DisclosureEntry { index: number; hash: string; prevHash: string; ts: string; verdict: string; decisionId: string; payloadHash: string; }
export interface Disclosure { from: number; to: number; head: unknown; entries: DisclosureEntry[]; signerPubkey: string; signature: string; }
export interface DisclosureVerdict { ok: boolean; reason?: string; }

const AUDIT_DOMAIN = 'blindseal.audit.v1';

export const isDisclosure = (doc: unknown): doc is Disclosure =>
  !!doc && typeof doc === 'object' && Array.isArray((doc as Disclosure).entries) && typeof (doc as Disclosure).signature === 'string';

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
export const canonicalJson = (v: unknown) => JSON.stringify(sortValue(v));

const enc = new TextEncoder();
const hexOf = (b: ArrayBuffer) => '0x' + Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function sha256Domain(domain: string, text: string): Promise<string> {
  const d = enc.encode(domain), t = enc.encode(text);
  const buf = new Uint8Array(d.length + t.length); buf.set(d); buf.set(t, d.length);
  return hexOf(await crypto.subtle.digest('SHA-256', buf));
}

export async function verifyDisclosure(d: Disclosure): Promise<DisclosureVerdict> {
  // 1) signature over canonicalJson({from,to,head,entries,signerPubkey}); signer = SPKI DER hex
  //    (12-byte Ed25519 SPKI prefix + 32-byte key). WebCrypto Ed25519 where the browser has it
  //    (Chromium ≥ 137), else the pure-JS @noble/ed25519 fallback.
  const spki = fromHex(d.signerPubkey);
  if (spki.length !== 44) return { ok: false, reason: 'bad signer pubkey' };
  const preimage = enc.encode(canonicalJson({ from: d.from, to: d.to, head: d.head, entries: d.entries, signerPubkey: d.signerPubkey }));
  const sig = fromHex(d.signature);
  let sigOk = false;
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    sigOk = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, preimage);
  } catch {
    try {
      const ed = await import('@noble/ed25519');
      sigOk = await ed.verifyAsync(sig, preimage, spki.slice(12));
    } catch { sigOk = false; }
  }
  if (!sigOk) return { ok: false, reason: 'signature mismatch' };
  // 2) each entry hash reproduces from its 6-field core; prevHash links within the window
  for (let i = 0; i < d.entries.length; i++) {
    const e = d.entries[i]!;
    const core = { index: e.index, ts: e.ts, decisionId: e.decisionId, verdict: e.verdict, payloadHash: e.payloadHash, prevHash: e.prevHash };
    if ((await sha256Domain(AUDIT_DOMAIN, canonicalJson(core))) !== e.hash) return { ok: false, reason: `entry ${e.index} hash mismatch` };
    if (i > 0 && e.prevHash !== d.entries[i - 1]!.hash) return { ok: false, reason: `entry ${e.index} prevHash does not link` };
  }
  return { ok: true };
}

export const isCleanWindow = (d: Disclosure, cleanVerdict: string = CLEAN_VERDICT) => d.entries.every((e) => e.verdict === cleanVerdict);
