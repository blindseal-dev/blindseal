/// On-disk store for manifest fingerprints. One JSON file per server key under the cache dir.
/// Tests inject a temp directory via the `cacheDir` option. The directory is 0700 and each file
/// 0600; a record holds only a hash of the server's command line, never the command or its args.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ManifestFingerprint } from './fingerprint.js';

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

export class ManifestStore {
  private readonly dir: string;

  constructor(cacheDir?: string) {
    this.dir = cacheDir && cacheDir.length > 0 ? cacheDir : defaultCacheDir();
  }

  private pathFor(serverKey: string): string {
    return path.join(this.dir, `${serverKey}.json`);
  }

  load(serverKey: string): StoredManifest | null {
    const file = this.pathFor(serverKey);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as StoredManifest;
    } catch {
      return null;
    }
  }

  save(record: StoredManifest): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const file = this.pathFor(record.serverKey);
    // A fixed field list, so nothing else on the record reaches disk. Each save overwrites the
    // file, which also drops the raw command/args an older cache kept.
    const { serverKey, commandHash, firstSeen, lastSeen, fingerprint } = record;
    writeFileSync(file, JSON.stringify({ serverKey, commandHash, firstSeen, lastSeen, fingerprint }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600); // writeFileSync's mode only applies when the file is created
  }
}
