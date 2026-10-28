// Audit finding #5 (0.7.0): every proxy decision is appended to ONE hash chain — and several
// processes (one proxy per wrapped MCP server, plus attest) append to the same files. Before
// 0.7.0 each AuditChain linked to its own in-memory tail and the ContentStore rewrote the
// whole file, so a second writer forked the chain and dropped the other's content.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditChain, ContentStore } from '../src/index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'bs-mw-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('several writers on one audit dir (audit #5)', () => {
  it('two chain instances interleaving appends keep one intact chain', () => {
    const log = path.join(dir, 'audit.log');
    const a = new AuditChain(log, 'pk');
    const b = new AuditChain(log, 'pk'); // a second process opened the same log
    a.append({ decisionId: 'a0', verdict: 'pass', payloadHash: '0x01' });
    b.append({ decisionId: 'b0', verdict: 'pass', payloadHash: '0x02' });
    a.append({ decisionId: 'a1', verdict: 'block', payloadHash: '0x03' });
    b.append({ decisionId: 'b1', verdict: 'flag', payloadHash: '0x04' });
    const fresh = new AuditChain(log, 'pk');
    expect(fresh.length).toBe(4);
    expect(fresh.all().map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(fresh.verify().ok).toBe(true);
    expect(a.head()?.index).toBe(3);
  });

  it('two content stores on one file both keep their records', () => {
    const store = path.join(dir, 'content.json');
    const key = path.join(dir, 'content.key');
    const a = new ContentStore(store, key);
    const b = new ContentStore(store, key);
    a.put('d1', { x: 1 });
    b.put('d2', { y: 2 });
    const fresh = new ContentStore(store, key);
    expect(fresh.get('d1')).toEqual({ x: 1 });
    expect(fresh.get('d2')).toEqual({ y: 2 });
    expect(a.get('d2')).toEqual({ y: 2 }); // written by the other instance
  });

  it('chain log and content store are created 0600; a legacy single-object store still reads', () => {
    const key = path.join(dir, 'content.key');
    const legacy = path.join(dir, 'legacy.json');
    const seed = new ContentStore(path.join(dir, 'seed.json'), key);
    seed.put('old', { v: 'legacy' });
    // rewrite the record in the pre-0.7.0 shape: one JSON object, no trailing newline
    const line = JSON.parse(readFileSync(path.join(dir, 'seed.json'), 'utf8').trim());
    writeFileSync(legacy, JSON.stringify({ old: { n: line.n, c: line.c } }));
    const s = new ContentStore(legacy, key);
    expect(s.get('old')).toEqual({ v: 'legacy' });
    s.put('new', { v: 'appended' });
    const fresh = new ContentStore(legacy, key);
    expect(fresh.get('old')).toEqual({ v: 'legacy' });
    expect(fresh.get('new')).toEqual({ v: 'appended' });

    const c = new ContentStore(path.join(dir, 'c.json'), key);
    c.put('d', {});
    expect(statSync(path.join(dir, 'c.json')).mode & 0o777).toBe(0o600);
    new AuditChain(path.join(dir, 'a.log'), 'pk').append({ decisionId: 'd', verdict: 'pass', payloadHash: '0x' });
    expect(statSync(path.join(dir, 'a.log')).mode & 0o777).toBe(0o600);
  });
});
