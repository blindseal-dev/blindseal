/// Selective disclosure (BLINDSEAL.md §3.6). A disclosure bundle is a window of audit
/// entries [from..to] plus the current head, signed with the proxy's ed25519 identity key
/// (~/.blindseal/identity.key). A verifier recomputes the entry-hash chain within the window
/// and checks the signature — no raw traffic is revealed. A "clean window" is a disclosure
/// where every entry's verdict is the clean marker.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, hashEntry, type EntryCore } from './hash.js';
import type { AuditEntry, AuditHead } from './chain.js';

export interface Disclosure {
  from: number;
  to: number;
  head: AuditHead;
  entries: AuditEntry[];
  signerPubkey: string; // ed25519 SPKI DER, hex
  signature: string; // ed25519 signature, hex
}

export interface DisclosureVerdict {
  ok: boolean;
  reason?: string;
}

/// Load (or generate at 0600) the ed25519 identity key; returns the KeyObject + SPKI-DER hex pubkey.
export function loadIdentity(keyPath: string): { privateKey: KeyObject; pubkeyHex: string } {
  let privateKey: KeyObject;
  if (existsSync(keyPath)) {
    privateKey = createPrivateKey({ key: Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex'), format: 'der', type: 'pkcs8' });
  } else {
    const kp = generateKeyPairSync('ed25519');
    privateKey = kp.privateKey;
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('hex') + '\n', { mode: 0o600 });
  }
  const pubkeyHex = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('hex');
  return { privateKey, pubkeyHex };
}

/// The signed preimage: canonical JSON of the window (excludes the signature itself).
function preimage(d: Omit<Disclosure, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ from: d.from, to: d.to, head: d.head, entries: d.entries, signerPubkey: d.signerPubkey }));
}

/// Build a signed disclosure for entries [from..to].
export function discloseBundle(args: {
  from: number;
  to: number;
  head: AuditHead;
  entries: AuditEntry[];
  privateKey: KeyObject;
  pubkeyHex: string;
}): Disclosure {
  const unsigned: Omit<Disclosure, 'signature'> = {
    from: args.from,
    to: args.to,
    head: args.head,
    entries: args.entries,
    signerPubkey: args.pubkeyHex,
  };
  const signature = sign(null, preimage(unsigned), args.privateKey).toString('hex');
  return { ...unsigned, signature };
}

/// Verify a disclosure: the entry-hash chain within the window is self-consistent AND the
/// signature is valid for the stated signer. Does not need the original chain or any content.
export function verifyDisclosure(d: Disclosure): DisclosureVerdict {
  // 1) signature
  let pub: KeyObject;
  try {
    pub = createPublicKey({ key: Buffer.from(d.signerPubkey, 'hex'), format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: 'bad signer pubkey' };
  }
  const unsigned: Omit<Disclosure, 'signature'> = {
    from: d.from,
    to: d.to,
    head: d.head,
    entries: d.entries,
    signerPubkey: d.signerPubkey,
  };
  if (!verify(null, preimage(unsigned), pub, Buffer.from(d.signature, 'hex'))) {
    return { ok: false, reason: 'signature mismatch' };
  }
  // 2) each entry's hash reproduces from its core, and prevHash links are consistent in-window
  for (let i = 0; i < d.entries.length; i++) {
    const e = d.entries[i]!;
    const core: EntryCore = {
      index: e.index,
      ts: e.ts,
      decisionId: e.decisionId,
      verdict: e.verdict,
      payloadHash: e.payloadHash,
      prevHash: e.prevHash,
    };
    if (hashEntry(core) !== e.hash) {
      return { ok: false, reason: `entry ${e.index} hash mismatch` };
    }
    if (i > 0 && e.prevHash !== d.entries[i - 1]!.hash) {
      return { ok: false, reason: `entry ${e.index} prevHash does not link` };
    }
  }
  return { ok: true };
}

/// A clean window: every disclosed entry has the clean verdict (default "pass").
export function isCleanWindow(d: Disclosure, cleanVerdict = 'pass'): boolean {
  return d.entries.every((e) => e.verdict === cleanVerdict);
}
