/// On-disk store for manifest fingerprints. One JSON file per server key under the cache dir.
/// Tests inject a temp directory via the `cacheDir` option. The directory is 0700 and each file
/// 0600; a record holds only a hash of the server's command line, never the command or its args.
///
/// Opening the store migrates the whole directory first (`migrateCacheDir`): records written by
/// older versions kept the raw command line (credentials passed as flags, token-bearing URLs) in
/// 0644 files, and a record whose server never runs again — a rotated credential changes the
/// key — would otherwise keep that secret forever.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { commandLineHash, type ManifestFingerprint } from './fingerprint.js';

export interface StoredManifest {
  serverKey: string;
  commandHash: string;
  firstSeen: string;
  lastSeen: string;
  fingerprint: ManifestFingerprint;
}

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'blindseal', 'manifests');
}

const SERVER_KEY_RE = /^[0-9a-f]{16}$/;
const TMP_RE = /^[0-9a-f]{16}\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
const STALE_TMP_MS = 10 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;

/// The record exactly as written: a fixed field list, so nothing else reaches disk.
function serialise(r: StoredManifest): string {
  const { serverKey, commandHash, firstSeen, lastSeen, fingerprint } = r;
  return JSON.stringify({ serverKey, commandHash, firstSeen, lastSeen, fingerprint }, null, 2) + '\n';
}

/// Write via a uniquely named 0600 temp file and rename, so a concurrent reader (several wrapped
/// servers start at once) never sees a partial file and the final file is never wider than 0600.
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function unlinkQuiet(file: string): void {
  try { unlinkSync(file); } catch { /* ENOENT: another process got there first */ }
}

/// A legacy or current record reduced to the schema, or null when it cannot be trusted (it is
/// then deleted rather than kept: an unreadable record may still hold a secret).
function sanitise(raw: unknown, serverKey: string): StoredManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const fp = r.fingerprint as ManifestFingerprint | undefined;
  if (!fp || typeof fp !== 'object' || typeof fp.fingerprint !== 'string') return null;
  let commandHash: string | null = null;
  if (typeof r.commandHash === 'string' && HASH_RE.test(r.commandHash)) commandHash = r.commandHash;
  else if (typeof r.command === 'string' && Array.isArray(r.args) && r.args.every((a) => typeof a === 'string')) {
    commandHash = commandLineHash(r.command, r.args as string[]);
  }
  if (!commandHash) return null;
  const firstSeen = typeof r.firstSeen === 'string' ? r.firstSeen : new Date(0).toISOString();
  const lastSeen = typeof r.lastSeen === 'string' ? r.lastSeen : firstSeen;
  return { serverKey, commandHash, firstSeen, lastSeen, fingerprint: fp };
}

export interface MigrationReport {
  rewritten: number;
  removed: number;
  /// Set when the directory could not be used safely (a symlink or not a directory).
  refused?: string;
}

/// Tightens the cache directory to 0700, then brings every entry to the current schema at 0600:
/// legacy records lose their raw command/args, unreadable records are deleted. Files the store did
/// not write are not touched.
/// Never follows symlinks; tolerates entries vanishing under concurrent migration; never throws.
export function migrateCacheDir(dir: string): MigrationReport {
  const report: MigrationReport = { rewritten: 0, removed: 0 };
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return report; // nothing cached yet
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    report.refused = 'the manifest cache path is not a plain directory';
    return report;
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    report.refused = 'could not restrict the manifest cache directory to 0700';
    return report;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return report;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let fst;
    try {
      fst = lstatSync(file);
    } catch {
      continue; // removed concurrently
    }
    if (fst.isDirectory()) continue;
    // Only files this store writes are touched: `<16 hex>.json` records and their temp files.
    // Anything else in the directory (if BLINDSEAL_MANIFEST_CACHE_DIR points somewhere shared) is
    // left alone. A temp file is removed only once stale, so a concurrent writer is not disturbed.
    const tmp = TMP_RE.exec(name);
    if (tmp) {
      if (Date.now() - fst.mtimeMs > STALE_TMP_MS) { unlinkQuiet(file); report.removed++; }
      continue;
    }
    const key = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!SERVER_KEY_RE.test(key)) continue;
    if (!fst.isFile()) {
      // A symlink (or other non-file) named like a record: never followed, removed.
      unlinkQuiet(file);
      report.removed++;
      continue;
    }
    try {
      const text = readFileSync(file, 'utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const rec = sanitise(parsed, key);
      if (!rec) {
        unlinkQuiet(file);
        report.removed++;
        continue;
      }
      const body = serialise(rec);
      if (body !== text || (fst.mode & 0o777) !== 0o600) {
        writeAtomic(file, body);
        report.rewritten++;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      unlinkQuiet(file); // could not be migrated: do not leave it behind
      report.removed++;
    }
  }
  return report;
}

export class ManifestStore {
  private readonly dir: string;
  /// Set when the directory is unsafe to use; the store then neither reads nor writes.
  readonly refused?: string;

  constructor(cacheDir?: string) {
    this.dir = cacheDir && cacheDir.length > 0 ? cacheDir : defaultCacheDir();
    const m = migrateCacheDir(this.dir);
    if (m.refused) {
      this.refused = m.refused;
      process.stderr.write(`blindseal: manifest cache disabled: ${m.refused} (${this.dir})\n`);
    }
  }

  private pathFor(serverKey: string): string {
    return path.join(this.dir, `${serverKey}.json`);
  }

  load(serverKey: string): StoredManifest | null {
    if (this.refused) return null;
    try {
      const st = lstatSync(this.pathFor(serverKey));
      if (!st.isFile()) return null;
      return sanitise(JSON.parse(readFileSync(this.pathFor(serverKey), 'utf8')), serverKey);
    } catch {
      return null;
    }
  }

  save(record: StoredManifest): void {
    if (this.refused) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      writeAtomic(this.pathFor(record.serverKey), serialise(record));
    } catch (err) {
      // A cache write failure costs drift detection for this run; it must not stop the proxy.
      process.stderr.write(`blindseal: manifest cache write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
