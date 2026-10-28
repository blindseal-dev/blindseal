/// SQLite-backed local scan history. Opt-in via BLINDSEAL_PERSIST=1.
/// Content-free: a row holds decision METADATA only (tool, verdict, layer, confidence, pattern
/// ids, content hash, mode, flags) plus the audit decisionId. What the decision was about — the
/// redacted response text and the judge's reasoning — is retained only in the encrypted content
/// store (<audit dir>/content.json), keyed by that decisionId; `blindseal history` decrypts it
/// locally. Databases written by earlier versions (content_preview / reasoning columns) are
/// scrubbed on open: the columns are dropped and the file vacuumed so no plaintext survives in
/// free pages or the WAL.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database, { type Database as Db, type Statement } from 'better-sqlite3';

export interface ScanRecord {
  id?: number;
  ts: number;
  serverKey: string;
  transport: 'stdio' | 'http' | 'sse';
  toolName: string;
  verdict: 'clean' | 'suspicious' | 'malicious';
  layer: number | null;
  confidence: number;
  patterns: string[];
  contentHash: string;
  /** The audit-chain decisionId: key of the redacted text + reasoning in the encrypted store. */
  decisionId: string | null;
  mode: string;
  mutated: boolean;
  /** Layer 2 was unavailable for this decision. */
  degraded: boolean;
}

export interface ScanInput {
  serverKey: string;
  transport: 'stdio' | 'http' | 'sse';
  toolName: string;
  verdict: 'clean' | 'suspicious' | 'malicious';
  layer: number | null;
  confidence: number;
  patterns: readonly string[];
  contentHash: string;
  /** The audit-chain decisionId (content lives in the encrypted store under this id). */
  decisionId?: string | null;
  mode: string;
  mutated: boolean;
  degraded?: boolean;
}

export interface ScanFilter {
  serverKey?: string;
  verdict?: 'clean' | 'suspicious' | 'malicious';
  since?: number; // ms epoch
  until?: number;
  limit?: number;
  offset?: number;
}

export interface ScanStoreConfig {
  enabled: boolean;
  /** Override default DB path (~/.blindseal/scans.db). */
  dbPath?: string;
  /** Days to retain. Older rows purged on every open. Default 30. */
  retentionDays?: number;
}

export interface ScanStore {
  readonly enabled: boolean;
  readonly dbPath: string | null;
  insert(input: ScanInput): void;
  list(filter?: ScanFilter): ScanRecord[];
  countByVerdict(): Record<'clean' | 'suspicious' | 'malicious', number>;
  countByDay(daysBack: number): Array<{ day: string; clean: number; suspicious: number; malicious: number }>;
  topTools(limit?: number): Array<{ toolName: string; total: number; malicious: number }>;
  recentMalicious(limit?: number): ScanRecord[];
  total(): number;
  purgeOlderThan(cutoffMs: number): number;
  close(): void;
}

const NOOP: ScanStore = {
  enabled: false,
  dbPath: null,
  insert() {},
  list() { return []; },
  countByVerdict() { return { clean: 0, suspicious: 0, malicious: 0 }; },
  countByDay() { return []; },
  topTools() { return []; },
  recentMalicious() { return []; },
  total() { return 0; },
  purgeOlderThan() { return 0; },
  close() {},
};

export function defaultDbPath(): string {
  return path.join(os.homedir(), '.blindseal', 'scans.db');
}

export function createScanStore(config: ScanStoreConfig): ScanStore {
  if (!config.enabled) return NOOP;

  const dbPath = config.dbPath ?? defaultDbPath();
  const retentionDays = config.retentionDays ?? 30;

  let db: Db;
  try {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  } catch (err) {
    process.stderr.write(
      `blindseal: persistence unavailable at ${dbPath} (${err instanceof Error ? err.message : String(err)}); disabling\n`,
    );
    return NOOP;
  }

  // Deleted rows are overwritten, not just unlinked (no plaintext left in free pages).
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_key TEXT NOT NULL,
      transport TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      verdict TEXT NOT NULL,
      layer INTEGER,
      confidence REAL NOT NULL,
      patterns TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      decision_id TEXT,
      mode TEXT NOT NULL,
      mutated INTEGER NOT NULL DEFAULT 0,
      degraded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_scans_ts ON scans(ts);
    CREATE INDEX IF NOT EXISTS idx_scans_server ON scans(server_key);
    CREATE INDEX IF NOT EXISTS idx_scans_verdict ON scans(verdict);
  `);

  // Databases from earlier versions: add the new columns, and remove the plaintext ones.
  const cols = db.prepare('PRAGMA table_info(scans)').all() as Array<{ name: string }>;
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('degraded')) db.exec('ALTER TABLE scans ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0');
  if (!has('decision_id')) db.exec('ALTER TABLE scans ADD COLUMN decision_id TEXT');
  if (has('content_preview') || has('reasoning')) {
    // Overwrite first (secure_delete covers the pages the drop frees), then drop the columns,
    // checkpoint the WAL and vacuum so the old plaintext is gone from every file.
    if (has('content_preview')) db.exec("UPDATE scans SET content_preview = ''");
    if (has('reasoning')) db.exec('UPDATE scans SET reasoning = NULL');
    if (has('content_preview')) db.exec('ALTER TABLE scans DROP COLUMN content_preview');
    if (has('reasoning')) db.exec('ALTER TABLE scans DROP COLUMN reasoning');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  const insertStmt: Statement = db.prepare(`
    INSERT INTO scans
      (ts, server_key, transport, tool_name, verdict, layer, confidence,
       patterns, content_hash, decision_id, mode, mutated, degraded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const purgeStmt: Statement = db.prepare('DELETE FROM scans WHERE ts < ?');
  const totalStmt: Statement = db.prepare('SELECT COUNT(*) AS n FROM scans');

  // Retention sweep on open.
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    purgeStmt.run(cutoff);
  }

  function rowToRecord(row: Record<string, unknown>): ScanRecord {
    return {
      id: row.id as number,
      ts: row.ts as number,
      serverKey: row.server_key as string,
      transport: row.transport as 'stdio' | 'http' | 'sse',
      toolName: row.tool_name as string,
      verdict: row.verdict as 'clean' | 'suspicious' | 'malicious',
      layer: row.layer as number | null,
      confidence: row.confidence as number,
      patterns: JSON.parse((row.patterns as string) || '[]') as string[],
      contentHash: row.content_hash as string,
      decisionId: (row.decision_id as string | null) ?? null,
      mode: row.mode as string,
      mutated: !!row.mutated,
      degraded: !!row.degraded,
    };
  }

  return {
    enabled: true,
    dbPath,
    insert(input) {
      insertStmt.run(
        Date.now(),
        input.serverKey,
        input.transport,
        input.toolName,
        input.verdict,
        input.layer,
        input.confidence,
        JSON.stringify(input.patterns ?? []),
        input.contentHash,
        input.decisionId ?? null,
        input.mode,
        input.mutated ? 1 : 0,
        input.degraded ? 1 : 0,
      );
    },
    list(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.serverKey) { where.push('server_key = ?'); params.push(filter.serverKey); }
      if (filter.verdict) { where.push('verdict = ?'); params.push(filter.verdict); }
      if (filter.since) { where.push('ts >= ?'); params.push(filter.since); }
      if (filter.until) { where.push('ts <= ?'); params.push(filter.until); }
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      const stmt = db.prepare(
        `SELECT * FROM scans ${whereClause} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      );
      const rows = stmt.all(...params, limit, offset) as Record<string, unknown>[];
      return rows.map(rowToRecord);
    },
    countByVerdict() {
      const rows = db
        .prepare('SELECT verdict, COUNT(*) AS n FROM scans GROUP BY verdict')
        .all() as Array<{ verdict: string; n: number }>;
      const out = { clean: 0, suspicious: 0, malicious: 0 };
      for (const r of rows) {
        if (r.verdict === 'clean' || r.verdict === 'suspicious' || r.verdict === 'malicious') {
          out[r.verdict] = r.n;
        }
      }
      return out;
    },
    countByDay(daysBack) {
      const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;
      const rows = db
        .prepare(`
          SELECT date(ts / 1000, 'unixepoch') AS day, verdict, COUNT(*) AS n
          FROM scans
          WHERE ts >= ?
          GROUP BY day, verdict
          ORDER BY day ASC
        `)
        .all(since) as Array<{ day: string; verdict: string; n: number }>;
      const byDay = new Map<string, { clean: number; suspicious: number; malicious: number }>();
      for (const r of rows) {
        const day = byDay.get(r.day) ?? { clean: 0, suspicious: 0, malicious: 0 };
        if (r.verdict === 'clean' || r.verdict === 'suspicious' || r.verdict === 'malicious') {
          day[r.verdict] = r.n;
        }
        byDay.set(r.day, day);
      }
      return [...byDay.entries()].map(([day, v]) => ({ day, ...v }));
    },
    topTools(limit = 10) {
      const rows = db
        .prepare(`
          SELECT tool_name AS toolName,
                 COUNT(*) AS total,
                 SUM(CASE WHEN verdict = 'malicious' THEN 1 ELSE 0 END) AS malicious
          FROM scans
          GROUP BY tool_name
          ORDER BY total DESC
          LIMIT ?
        `)
        .all(limit) as Array<{ toolName: string; total: number; malicious: number }>;
      return rows;
    },
    recentMalicious(limit = 10) {
      const rows = db
        .prepare(`SELECT * FROM scans WHERE verdict = 'malicious' ORDER BY ts DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
      return rows.map(rowToRecord);
    },
    total() {
      const r = totalStmt.get() as { n: number };
      return r.n;
    },
    purgeOlderThan(cutoffMs) {
      return purgeStmt.run(cutoffMs).changes;
    },
    close() {
      db.close();
    },
  };
}

export function loadScanStoreConfig(): ScanStoreConfig {
  const flag = process.env.BLINDSEAL_PERSIST?.toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'on';
  const dbPath = process.env.BLINDSEAL_PERSIST_PATH;
  const retentionDays = (() => {
    const raw = process.env.BLINDSEAL_RETENTION_DAYS;
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  return { enabled, dbPath, retentionDays };
}
