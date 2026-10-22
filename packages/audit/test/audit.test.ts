import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditChain, ContentStore, openAudit, discloseBundle, verifyDisclosure, isCleanWindow } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bs-audit-'));
});

const PK = '0xcafe';

describe('audit chain', () => {
  it('appends, links, and verifies', () => {
    const c = new AuditChain(path.join(dir, 'audit.log'), PK);
    const e0 = c.append({ decisionId: 'd0', verdict: 'pass', payloadHash: '0xaa' });
    const e1 = c.append({ decisionId: 'd1', verdict: 'block', payloadHash: '0xbb' });
    expect(e0.index).toBe(0);
    expect(e1.prevHash).toBe(e0.hash);
    expect(c.head()).toMatchObject({ index: 1, hash: e1.hash });
    expect(c.verify().ok).toBe(true);
  });

  it('persists and reloads identically', () => {
    const p = path.join(dir, 'audit.log');
    const c = new AuditChain(p, PK);
    c.append({ decisionId: 'd0', verdict: 'pass', payloadHash: '0xaa' });
    c.append({ decisionId: 'd1', verdict: 'pass', payloadHash: '0xbb' });
    const reloaded = new AuditChain(p, PK);
    expect(reloaded.length).toBe(2);
    expect(reloaded.verify().ok).toBe(true);
  });

  it('detects a tampered entry', () => {
    const p = path.join(dir, 'audit.log');
    const c = new AuditChain(p, PK);
    c.append({ decisionId: 'd0', verdict: 'pass', payloadHash: '0xaa' });
    c.append({ decisionId: 'd1', verdict: 'block', payloadHash: '0xbb' });
    c.append({ decisionId: 'd2', verdict: 'pass', payloadHash: '0xcc' });
    // flip a verdict in the persisted log, reload, verify
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const mid = JSON.parse(lines[1]!);
    mid.verdict = 'pass'; // was 'block'
    lines[1] = JSON.stringify(mid);
    writeFileSync(p, lines.join('\n') + '\n');
    const v = new AuditChain(p, PK).verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });
});

describe('encrypted content store', () => {
  it('round-trips content and reloads with the same key', () => {
    const sp = path.join(dir, 'content.json');
    const kp = path.join(dir, 'content.key');
    const s = new ContentStore(sp, kp);
    s.put('d0', { redacted: '[REDACTED:email:1]', redactions: [{ kind: 'email', count: 1 }] });
    expect(s.get<{ redacted: string }>('d0')!.redacted).toBe('[REDACTED:email:1]');
    expect(new ContentStore(sp, kp).get('d0')).not.toBeNull();
  });

  it('stores ciphertext, not plaintext, on disk', () => {
    const sp = path.join(dir, 'content.json');
    const s = new ContentStore(sp, path.join(dir, 'content.key'));
    s.put('d0', { secret: 'TOPSECRETVALUE' });
    expect(readFileSync(sp, 'utf8')).not.toContain('TOPSECRETVALUE');
  });

  it('a wrong key cannot decrypt', () => {
    const sp = path.join(dir, 'content.json');
    const s = new ContentStore(sp, path.join(dir, 'k1.key'));
    s.put('d0', { x: 1 });
    writeFileSync(path.join(dir, 'k2.key'), 'ab'.repeat(32) + '\n');
    const wrong = new ContentStore(sp, path.join(dir, 'k2.key'));
    expect(() => wrong.get('d0')).toThrow();
  });
});

describe('selective disclosure', () => {
  it('discloses a window that verifies, and detects tampering', () => {
    const a = openAudit(dir);
    a.chain.append({ decisionId: 'd0', verdict: 'pass', payloadHash: '0xaa' });
    a.chain.append({ decisionId: 'd1', verdict: 'pass', payloadHash: '0xbb' });
    a.chain.append({ decisionId: 'd2', verdict: 'block', payloadHash: '0xcc' });
    const bundle = a.disclose(0, 2);
    expect(bundle.entries).toHaveLength(3);
    expect(verifyDisclosure(bundle).ok).toBe(true);
    expect(isCleanWindow(bundle)).toBe(false); // d2 is a block

    // tamper a disclosed entry -> verify fails
    const tampered = structuredClone(bundle);
    tampered.entries[2]!.verdict = 'pass';
    expect(verifyDisclosure(tampered).ok).toBe(false);

    // tamper the signature -> verify fails
    const badSig = structuredClone(bundle);
    badSig.signature = badSig.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect(verifyDisclosure(badSig).ok).toBe(false);
  });

  it('a clean window is all-pass', () => {
    const a = openAudit(dir);
    a.chain.append({ decisionId: 'd0', verdict: 'pass', payloadHash: '0xaa' });
    a.chain.append({ decisionId: 'd1', verdict: 'pass', payloadHash: '0xbb' });
    const bundle = a.disclose(0, 1);
    expect(verifyDisclosure(bundle).ok).toBe(true);
    expect(isCleanWindow(bundle)).toBe(true);
  });
});
