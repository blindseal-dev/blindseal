/// The append-only JSONL log (<dataDir>/dogfood.jsonl): one line per tick, written once, when the tick
/// is over (whatever its outcome). Entries carry timestamps, the signature and the x402 receipt, the
/// spend the ledger counts, and `dryRun`. Nothing in an entry is secret: no keys, no RPC URL.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type TickStatus = 'ok' | 'blocked' | 'failed' | 'capped';

export interface StepRecord { startedAt: string; finishedAt: string; ok: boolean; detail?: string }

export interface X402Record {
  resource: string;
  /// 'paid' = a 402 was answered with a payment; 'free' = the server answered 200 without asking.
  status: 'paid' | 'free';
  priceAtomic: string;
  asset?: string;
  payTo?: string;
  network?: string;
  /// Decoded PAYMENT-RESPONSE (v2) / X-PAYMENT-RESPONSE (v1) header: the facilitator's settlement receipt.
  receipt?: unknown;
}

export interface AttestationRecord {
  file: string;
  decisionId: string;
  nullifier: string;
  payloadHash: string;
  expirySlot: number;
  prover: string;
}

export interface TickEntry {
  ts: string;
  tick: string;
  dryRun: boolean;
  status: TickStatus;
  wallet: string;
  steps: Partial<Record<'buy' | 'transfer' | 'attest' | 'submit', StepRecord>>;
  x402?: X402Record;
  attestation?: AttestationRecord;
  /// The gated transfer's signature (dry run: the fixture's known consume signature, labelled simulated).
  signature?: string;
  simulated?: true;
  /// What this tick spent, or would have spent in dry run; the ledger sums these.
  spend: { lamports: number; usdcAtomic: number };
  blocked?: { tool: string; direction: 'request' | 'response' | 'capability'; notice: string };
  error?: string;
  /// Proxy stderr lines that report a verdict, bounded.
  proxyNotices?: string[];
  finishedAt?: string;
}

export function logPath(dataDir: string): string { return path.join(dataDir, 'dogfood.jsonl'); }

export function appendEntry(file: string, entry: TickEntry): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/// Every parseable line, oldest first. A corrupt line is skipped, not fatal: the log is evidence, and
/// the ledger must keep counting what it can read.
export function readEntries(file: string): TickEntry[] {
  if (!existsSync(file)) return [];
  const out: TickEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TickEntry;
      if (e && typeof e.ts === 'string' && e.spend) out.push(e);
    } catch { /* skip */ }
  }
  return out;
}
