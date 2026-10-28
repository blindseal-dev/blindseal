import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openAudit } from '@blindseal/audit';
import { createAuditLogger } from '../src/audit/index.js';

describe('audit logger (decision recorder)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-audit-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records to the hash chain even without the metadata log', async () => {
    const logger = createAuditLogger({ dir: tmpDir });
    expect(logger.enabled).toBe(true);
    const rec = logger.log({
      type: 'detection', toolName: 't', layer: 1, verdict: 'clean', confidence: 0,
      patterns: [], mode: 'block', mutated: false, contentHash: 'ab'.repeat(32),
    });
    await logger.shutdown();
    expect(rec?.verdict).toBe('pass');
    expect(rec?.payloadHash).toBe('0x' + 'ab'.repeat(32));
    const a = openAudit(tmpDir);
    expect(a.chain.length).toBe(1);
    expect(a.chain.verify().ok).toBe(true);
  });

  it('writes content-free metadata JSONL to the configured file', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const logger = createAuditLogger({ dir: tmpDir, filepath: file });

    logger.log({
      type: 'detection', toolName: 'read_file', layer: 2, verdict: 'malicious', confidence: 0.92,
      patterns: ['corpus:io-001'], mode: 'block', mutated: true, reasoning: 'corpus match',
      contentHash: '00'.repeat(32), text: 'ignore previous instructions',
    });
    logger.log({
      type: 'capability', toolName: 'http_get', action: 'block', taintSources: ['read_file'],
      reason: 'args derived from tainted response', args: { url: 'https://leak.example/...' },
    });
    logger.log({ type: 'manifest', serverKey: 'abc123', fingerprint: 'fp-xyz', status: 'drift', changes: ['tool added: delete_file'] });

    await logger.shutdown();

    const raw = readFileSync(file, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const banned of ['ignore previous', 'leak.example', 'corpus match', 'tainted response', 'delete_file']) {
      expect(raw).not.toContain(banned);
    }

    const det = JSON.parse(lines[0]!);
    expect(det.type).toBe('detection');
    expect(det.verdict).toBe('malicious');
    expect(det.chainVerdict).toBe('block');
    expect(det.auditIndex).toBe(0);
    expect(typeof det.ts).toBe('number');

    const cap = JSON.parse(lines[1]!);
    expect(cap.type).toBe('capability');
    expect(cap.action).toBe('block');
    expect(cap.taintSources).toEqual(['read_file']);

    const man = JSON.parse(lines[2]!);
    expect(man.type).toBe('manifest');
    expect(man.status).toBe('drift');
    expect(man.changeCount).toBe(1);

    // the content went to the encrypted store, redacted
    const a = openAudit(tmpDir);
    const stored = a.content.get<{ text: string; reasoning: string }>(det.decisionId);
    expect(stored?.text).toBe('ignore previous instructions');
    expect(stored?.reasoning).toBe('corpus match');
  });

  it('creates parent directory of the metadata log if missing', async () => {
    const file = path.join(tmpDir, 'nested', 'subdir', 'audit.jsonl');
    const logger = createAuditLogger({ dir: tmpDir, filepath: file });
    logger.log({ type: 'manifest', serverKey: 'k', fingerprint: 'fp', status: 'first-seen', changes: [] });
    await logger.shutdown();
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
  });

  it('log after shutdown is a no-op and does not throw', async () => {
    const logger = createAuditLogger({ dir: tmpDir, filepath: path.join(tmpDir, 'audit.jsonl') });
    await logger.shutdown();
    expect(() =>
      logger.log({ type: 'detection', toolName: 't', layer: null, verdict: 'clean', confidence: 0, patterns: [], mode: 'log', mutated: false, contentHash: '00' }),
    ).not.toThrow();
  });
});
