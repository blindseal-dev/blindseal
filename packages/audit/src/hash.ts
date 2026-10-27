/// Canonical hashing for the Blindseal audit chain. All hashes are
/// SHA-256, domain-separated, over canonical (sorted-key) JSON so the digest is independent
/// of key insertion order.
import { createHash } from 'node:crypto';

/// Deterministic JSON: object keys sorted recursively. Arrays keep order.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/// sha256(domain || bytes) as 0x-hex.
export function sha256Domain(domain: string, bytes: Buffer | string): string {
  return '0x' + createHash('sha256').update(domain).update(bytes).digest('hex');
}

export const AUDIT_DOMAIN = 'blindseal.audit.v1';
export const GENESIS_DOMAIN = 'blindseal.audit.genesis.v1';

/// The 6-field core that is hashed (the derived `hash` is NOT part of the preimage).
export interface EntryCore {
  index: number;
  ts: string;
  decisionId: string;
  verdict: string;
  payloadHash: string;
  prevHash: string;
}

export function hashEntry(core: EntryCore): string {
  return sha256Domain(AUDIT_DOMAIN, canonicalJson(core));
}

/// genesis prevHash = sha256("blindseal.audit.genesis.v1" || proxyIdentityPubkey)
export function genesisPrevHash(proxyIdentityPubkey: string): string {
  return sha256Domain(GENESIS_DOMAIN, proxyIdentityPubkey);
}
