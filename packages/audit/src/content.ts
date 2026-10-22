/// Encrypted content store (BLINDSEAL.md §3.6). The audit chain entries are content-free;
/// the actual decision content (layer results, redacted payload, redaction counts) lives
/// here, encrypted at rest with XChaCha20-Poly1305. The key sits at ~/.blindseal/content.key
/// (generated on first use, 0600). Loss of the key means loss of the content, never of the
/// chain's integrity.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './hash.js';

interface Sealed {
  n: string; // nonce (24 bytes) hex
  c: string; // ciphertext+tag hex
}

export class ContentStore {
  private readonly key: Uint8Array;
  private readonly map: Record<string, Sealed>;

  constructor(
    private readonly storePath: string,
    keyPath: string,
  ) {
    this.key = loadOrCreateKey(keyPath);
    this.map = existsSync(storePath) ? (JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, Sealed>) : {};
    if (!existsSync(storePath)) mkdirSync(path.dirname(storePath), { recursive: true });
  }

  /// Encrypt and store content for a decision. Content is canonicalized before sealing.
  put(decisionId: string, content: unknown): void {
    const nonce = new Uint8Array(nodeRandomBytes(24));
    const pt = new TextEncoder().encode(canonicalJson(content));
    const ct = xchacha20poly1305(this.key, nonce).encrypt(pt);
    this.map[decisionId] = { n: toHex(nonce), c: toHex(ct) };
    writeFileSync(this.storePath, JSON.stringify(this.map));
  }

  /// Decrypt stored content; null if absent. Throws if the ciphertext/tag fails to verify.
  get<T = unknown>(decisionId: string): T | null {
    const sealed = this.map[decisionId];
    if (!sealed) return null;
    const pt = xchacha20poly1305(this.key, fromHex(sealed.n)).decrypt(fromHex(sealed.c));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }

  has(decisionId: string): boolean {
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
