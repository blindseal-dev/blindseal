/// Append-only hash-chained audit log. Entries are content-free by
/// construction (only hashes/ids/verdict); decision content lives in the encrypted
/// ContentStore. Persisted as JSONL so appends are atomic line writes and the chain can be
/// recomputed from genesis.
///
/// Several processes may append to the same log (one proxy per wrapped MCP server, plus
/// `blindseal attest`). Each append takes an exclusive lock file, reads any lines other
/// processes added since this instance last looked, links to the true tail, then appends.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readSync } from 'node:fs';
import path from 'node:path';
import { genesisPrevHash, hashEntry, type EntryCore } from './hash.js';

export interface AuditEntry extends EntryCore {
  /// Derived: sha256(domain || canonicalJson(core)). Not part of the preimage.
  hash: string;
}

export interface AuditHead {
  index: number;
  hash: string;
  ts: string;
}

export interface AppendInput {
  decisionId: string;
  verdict: string;
  payloadHash: string;
  ts?: string;
}

export interface VerifyResult {
  ok: boolean;
  checkedFrom: number;
  checkedTo: number;
  brokenAt?: number;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class AuditChain {
  private entries: AuditEntry[] = [];
  private readonly genesis: string;
  /// Bytes of the log file already parsed into `entries`.
  private synced = 0;

  constructor(
    private readonly logPath: string,
    proxyIdentityPubkey: string,
  ) {
    this.genesis = genesisPrevHash(proxyIdentityPubkey);
    if (!existsSync(logPath)) mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    this.refresh();
  }

  /// Parse whatever complete lines were appended to the file since the last refresh.
  private refresh(): void {
    if (!existsSync(this.logPath)) return;
    const size = statSync(this.logPath).size;
    if (size <= this.synced) return;
    const fd = openSync(this.logPath, 'r');
    try {
      const buf = Buffer.alloc(size - this.synced);
      readSync(fd, buf, 0, buf.length, this.synced);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return; // a partial line: another writer is mid-append
      for (const line of text.slice(0, end).split('\n')) {
        const t = line.trim();
        if (t) this.entries.push(JSON.parse(t) as AuditEntry);
      }
      this.synced += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  private withLock<T>(fn: () => T): T {
    const lock = this.logPath + '.lock';
    const t0 = Date.now();
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); // holder died
        } catch { /* lock vanished: retry */ }
        if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`audit log lock ${lock} held too long`);
        sleepSync(2);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  get length(): number {
    this.refresh();
    return this.entries.length;
  }

  private prevHash(): string {
    return this.entries.length === 0 ? this.genesis : this.entries[this.entries.length - 1]!.hash;
  }

  /// Append a content-free entry; computes index, prevHash, and the chained hash, and
  /// persists one JSONL line. Returns the full entry.
  append(input: AppendInput): AuditEntry {
    return this.withLock(() => {
      this.refresh(); // link to the true tail, including other processes' appends
      const core: EntryCore = {
        index: this.entries.length,
        ts: input.ts ?? new Date().toISOString(),
        decisionId: input.decisionId,
        verdict: input.verdict,
        payloadHash: input.payloadHash,
        prevHash: this.prevHash(),
      };
      const entry: AuditEntry = { ...core, hash: hashEntry(core) };
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.logPath, line, { mode: 0o600 });
      this.entries.push(entry);
      this.synced += Buffer.byteLength(line, 'utf8');
      return entry;
    });
  }

  head(): AuditHead | null {
    this.refresh();
    const last = this.entries[this.entries.length - 1];
    return last ? { index: last.index, hash: last.hash, ts: last.ts } : null;
  }

  slice(from: number, to: number): AuditEntry[] {
    this.refresh();
    return this.entries.filter((e) => e.index >= from && e.index <= to);
  }

  all(): AuditEntry[] {
    this.refresh();
    return [...this.entries];
  }

  /// Recompute the chain from genesis; report the first index whose prevHash link or hash
  /// does not reproduce (tamper/truncation detection).
  verify(): VerifyResult {
    this.refresh();
    let prev = this.genesis;
    for (const e of this.entries) {
      const core: EntryCore = {
        index: e.index,
        ts: e.ts,
        decisionId: e.decisionId,
        verdict: e.verdict,
        payloadHash: e.payloadHash,
        prevHash: prev,
      };
      if (e.prevHash !== prev || e.hash !== hashEntry(core)) {
        return { ok: false, checkedFrom: 0, checkedTo: this.entries.length - 1, brokenAt: e.index };
      }
      prev = e.hash;
    }
    return { ok: true, checkedFrom: 0, checkedTo: this.entries.length - 1 };
  }

  genesisHash(): string {
    return this.genesis;
  }
}
