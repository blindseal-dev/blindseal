/// Append-only hash-chained audit log (BLINDSEAL.md §3.6). Entries are content-free by
/// construction (only hashes/ids/verdict); decision content lives in the encrypted
/// ContentStore. Persisted as JSONL so appends are atomic line writes and the chain can be
/// recomputed from genesis.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
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

export class AuditChain {
  private entries: AuditEntry[] = [];
  private readonly genesis: string;

  constructor(
    private readonly logPath: string,
    proxyIdentityPubkey: string,
  ) {
    this.genesis = genesisPrevHash(proxyIdentityPubkey);
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (t) this.entries.push(JSON.parse(t) as AuditEntry);
      }
    } else {
      mkdirSync(path.dirname(logPath), { recursive: true });
    }
  }

  get length(): number {
    return this.entries.length;
  }

  private prevHash(): string {
    return this.entries.length === 0 ? this.genesis : this.entries[this.entries.length - 1]!.hash;
  }

  /// Append a content-free entry; computes index, prevHash, and the chained hash, and
  /// persists one JSONL line. Returns the full entry.
  append(input: AppendInput): AuditEntry {
    const core: EntryCore = {
      index: this.entries.length,
      ts: input.ts ?? new Date().toISOString(),
      decisionId: input.decisionId,
      verdict: input.verdict,
      payloadHash: input.payloadHash,
      prevHash: this.prevHash(),
    };
    const entry: AuditEntry = { ...core, hash: hashEntry(core) };
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    this.entries.push(entry);
    return entry;
  }

  head(): AuditHead | null {
    const last = this.entries[this.entries.length - 1];
    return last ? { index: last.index, hash: last.hash, ts: last.ts } : null;
  }

  slice(from: number, to: number): AuditEntry[] {
    return this.entries.filter((e) => e.index >= from && e.index <= to);
  }

  all(): AuditEntry[] {
    return [...this.entries];
  }

  /// Recompute the chain from genesis; report the first index whose prevHash link or hash
  /// does not reproduce (tamper/truncation detection).
  verify(): VerifyResult {
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
