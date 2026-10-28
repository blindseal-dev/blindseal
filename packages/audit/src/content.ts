/// Encrypted content store. The audit chain entries are content-free;
/// the actual decision content (layer results, redacted payload, redaction counts) lives
/// here, encrypted at rest with XChaCha20-Poly1305. The key sits at ~/.blindseal/content.key
/// (generated on first use, 0600). Loss of the key means loss of the content, never of the
/// chain's integrity.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './hash.js';

interface Sealed {
  n: string; // nonce (24 bytes) hex
  c: string; // ciphertext+tag hex
}

/// On disk: one JSON line per sealed record, `{"id":…,"n":…,"c":…}`, appended (so several
/// processes can write the same store without overwriting each other). A file from an older
/// version holding one JSON object `{ <id>: {n,c}, … }` is still read. File mode 0600.
export class ContentStore {
  private readonly key: Uint8Array;
  private map: Record<string, Sealed> = {};
  /// A legacy single-object file has no trailing newline; the first appended record needs one.
  private needsNewline = false;

  constructor(
    private readonly storePath: string,
    keyPath: string,
  ) {
    this.key = loadOrCreateKey(keyPath);
    if (!existsSync(storePath)) mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    this.load();
  }

  private load(): void {
    this.map = {};
    if (!existsSync(this.storePath)) return;
    const raw = readFileSync(this.storePath, 'utf8');
    this.needsNewline = raw.length > 0 && !raw.endsWith('\n');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec: unknown;
      try { rec = JSON.parse(t); } catch { continue; } // a torn line from a crashed writer
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      if (typeof r.id === 'string' && typeof r.n === 'string' && typeof r.c === 'string') {
        this.map[r.id] = { n: r.n, c: r.c };
      } else {
        Object.assign(this.map, r as Record<string, Sealed>); // legacy single-object map
      }
    }
  }

  /// Encrypt and store content for a decision. Content is canonicalized before sealing.
  put(decisionId: string, content: unknown): void {
    const nonce = new Uint8Array(nodeRandomBytes(24));
    const pt = new TextEncoder().encode(canonicalJson(content));
    const ct = xchacha20poly1305(this.key, nonce).encrypt(pt);
    const sealed = { n: toHex(nonce), c: toHex(ct) };
    const prefix = this.needsNewline ? '\n' : '';
    this.needsNewline = false;
    appendFileSync(this.storePath, prefix + JSON.stringify({ id: decisionId, ...sealed }) + '\n', { mode: 0o600 });
    this.map[decisionId] = sealed;
  }

  /// Decrypt stored content; null if absent. Throws if the ciphertext/tag fails to verify.
  get<T = unknown>(decisionId: string): T | null {
    if (!this.map[decisionId]) this.load(); // another process may have written it
    const sealed = this.map[decisionId];
    if (!sealed) return null;
    const pt = xchacha20poly1305(this.key, fromHex(sealed.n)).decrypt(fromHex(sealed.c));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }

  has(decisionId: string): boolean {
    if (!(decisionId in this.map)) this.load();
    return decisionId in this.map;
  }
}

function loadOrCreateKey(keyPath: string): Uint8Array {
  if (existsSync(keyPath)) {
    return fromHex(readFileSync(keyPath, 'utf8').trim());
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = new Uint8Array(nodeRandomBytes(32));
  writeFileSync(keyPath, toHex(key) + '\n', { mode: 0o600 });
  return key;
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}
