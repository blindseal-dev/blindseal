/// Audit finding #4 (records): the degraded flag is stored with each scan in the local history
/// database, including databases created by earlier versions (column added in place).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createScanStore } from '../src/persistence/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dbFile = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'bs-scans-')); dirs.push(d); return path.join(d, 'scans.db'); };

const input = (degraded: boolean) => ({
  serverKey: 'stdio:node:fixture', transport: 'stdio' as const, toolName: 'read_file', verdict: 'clean' as const,
  layer: 1, confidence: 0, patterns: [], contentHash: 'ab', decisionId: null, mode: 'block', mutated: false, degraded,
});

describe('scan history: degraded flag', () => {
  it('round-trips degraded on new databases', () => {
    const store = createScanStore({ enabled: true, dbPath: dbFile() });
    store.insert(input(true));
    store.insert(input(false));
    const rows = store.list();
    expect(rows.map((r) => (r as { degraded?: boolean }).degraded).sort()).toEqual([false, true]);
    store.close();
  });

  it('adds the column to a database created before it existed', () => {
    const file = dbFile();
    const old = new Database(file);
    old.exec(`CREATE TABLE scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, server_key TEXT NOT NULL, transport TEXT NOT NULL,
      tool_name TEXT NOT NULL, verdict TEXT NOT NULL, layer INTEGER, confidence REAL NOT NULL, patterns TEXT NOT NULL,
      content_hash TEXT NOT NULL, content_preview TEXT NOT NULL, reasoning TEXT, mode TEXT NOT NULL,
      mutated INTEGER NOT NULL DEFAULT 0)`);
    old.prepare(`INSERT INTO scans (ts, server_key, transport, tool_name, verdict, layer, confidence, patterns, content_hash, content_preview, reasoning, mode, mutated)
      VALUES (?, 's', 'stdio', 't', 'clean', 1, 0, '[]', 'h', 'p', NULL, 'block', 0)`).run(Date.now());
    old.close();

    const store = createScanStore({ enabled: true, dbPath: file });
    store.insert(input(true));
    const rows = store.list();
    expect(rows).toHaveLength(2);
    const flags = rows.map((r) => (r as { degraded?: boolean }).degraded);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
    store.close();
  });
});
