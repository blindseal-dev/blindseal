// Audit finding #10 (0.7.0): one canonical success verdict. The chain writers (attest, the
// proxy), `blindseal verify`, the browser verifiers and the fixtures must agree on it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_VERDICT, CHAIN_VERDICTS, toChainVerdict, isCleanWindow } from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p));

describe('canonical chain verdict (audit #10)', () => {
  it('the success verdict is "pass" and isCleanWindow defaults to it', () => {
    expect(CLEAN_VERDICT).toBe('pass');
    const entry = (verdict: string) => ({ index: 0, ts: '', decisionId: 'd', verdict, payloadHash: '0x', prevHash: '0x', hash: '0x' });
    const d = (verdict: string) => ({ from: 0, to: 0, head: { index: 0, hash: '0x', ts: '' }, entries: [entry(verdict)], signerPubkey: '', signature: '' });
    expect(isCleanWindow(d(CLEAN_VERDICT))).toBe(true);
    expect(isCleanWindow(d('clean'))).toBe(false);
  });

  it('detector verdicts and capability actions map onto the chain vocabulary', () => {
    expect(toChainVerdict('clean')).toBe(CLEAN_VERDICT);
    expect(toChainVerdict('allow')).toBe(CLEAN_VERDICT);
    expect(toChainVerdict('suspicious')).toBe('flag');
    expect(toChainVerdict('warn')).toBe('flag');
    expect(toChainVerdict('malicious')).toBe('block');
    expect(toChainVerdict('block')).toBe('block');
    expect(toChainVerdict('anything-else')).toBe('error');
  });

  it('the browser verifiers carry a byte-identical copy of verdict.ts', () => {
    const canonical = read('packages/audit/src/verdict.ts');
    for (const copy of ['apps/site/app/verify/verdict.ts', 'packages/dashboard/src/verify/verdict.ts']) {
      expect(read(copy).equals(canonical), copy).toBe(true);
    }
  });

  it('the browser verifiers test a clean window against CLEAN_VERDICT, not a literal', () => {
    for (const f of ['apps/site/app/verify/disclosure.ts', 'packages/dashboard/src/verify/disclosure.ts', 'apps/site/app/verify/verify-client.tsx']) {
      const src = read(f).toString('utf8');
      expect(src, f).toContain("from './verdict'");
      expect(src, f).not.toMatch(/verdict\s*(!==|===|=)\s*'pass'|cleanVerdict\s*=\s*'pass'/);
    }
  });

  it('every chain fixture uses only the canonical vocabulary', () => {
    const files = ['fixtures/audit.json', 'apps/site/app/verify/disclosure-sample.json'];
    for (const f of files) {
      const doc = JSON.parse(read(f).toString('utf8')) as { entries: { verdict: string }[] };
      expect(doc.entries.length, f).toBeGreaterThan(0);
      for (const e of doc.entries) expect(CHAIN_VERDICTS as readonly string[], f).toContain(e.verdict);
    }
  });
});
