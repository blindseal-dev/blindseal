/// A small pool of scan workers (scan-worker.ts) so Layer 0/1, redaction and blob decoding never
/// run on the event loop: a slow message cannot stall other messages or /health.
///
/// Budget: a scan is sent with the time left in its message's allowance (waiting in the queue does
/// not count) and the worker reports what it used. The main thread also keeps a hard deadline:
/// a worker still busy past the allowance plus a small slack is terminated and replaced, and the
/// message gets the budget result (blocked in block mode).
///
/// If no worker can be started, the operations run inline and stderr says so once
/// ("scan worker unavailable"); the packed-proxy regressions assert that line never appears.
/// (worker-pool.ts has the mechanics.)

import os from 'node:os';
import { runScanOp, type ScanOp, type ScanResult } from './scan-ops.js';
import { WorkerPool, OverrunError } from './worker-pool.js';
import type { ScanBudget } from './scan-budget.js';
import type { L0Result } from './layer0-decoder.js';
import type { DetectionResult } from './types.js';

const SCAN_SLACK_MS = 250;
const OTHER_OP_TIMEOUT_MS = 60_000;

function readPoolSize(): number {
  const n = Number(process.env.BLINDSEAL_SCAN_WORKERS);
  if (Number.isInteger(n) && n > 0 && n <= 64) return n;
  return Math.min(4, Math.max(2, os.availableParallelism() - 1));
}

const pool = new WorkerPool<ScanOp, ScanResult>('scan', 'scan-worker', readPoolSize, runScanOp);

/// Inputs up to this many characters are handled on the calling thread: Layer 0/1, redaction and
/// decoding of 4 KB take microseconds (every step is linear), less than a round trip to a worker.
/// Anything larger always goes to a worker.
export const INLINE_MAX_CHARS = 4096;

function opSize(op: ScanOp): number {
  switch (op.op) {
    case 'scan': case 'redact': return op.text.length;
    case 'outbound-each': return op.texts.reduce((n, t) => n + t.length, 0);
    case 'redact-value': case 'model-forms': return op.op === 'model-forms' ? op.json.length + op.skip.reduce((n, t) => n + t.length, 0) : op.json.length;
    case 'blob': return op.value.length;
  }
}

function submit(op: ScanOp, timeoutMs: number): Promise<ScanResult> {
  if (opSize(op) <= INLINE_MAX_CHARS) return Promise.resolve().then(() => runScanOp(op));
  return pool.submit(op, timeoutMs);
}

type BudgetedOp = Extract<ScanOp, { ms: number }>;

async function budgeted<T extends ScanResult & { usedMs: number }>(op: BudgetedOp, budget: ScanBudget): Promise<T | null> {
  const ms = budget.remainingMs();
  if (ms <= 0) return null;
  try {
    const r = (await submit({ ...op, ms } as BudgetedOp, ms + SCAN_SLACK_MS)) as T;
    if (r.op !== op.op) throw new Error('scan worker: wrong reply');
    budget.charge(r.usedMs);
    return r;
  } catch (err) {
    if (err instanceof OverrunError) {
      budget.exhaust();
      return null;
    }
    throw err;
  }
}

/// Layer 0 then Layer 1 on `text` in a worker, charged to `budget`.
export async function scanText(text: string, budget: ScanBudget): Promise<{ l0: L0Result; l1: DetectionResult | null }> {
  const r = await budgeted<Extract<ScanResult, { op: 'scan' }>>({ op: 'scan', text, ms: 0 }, budget);
  if (!r) return { l0: { fired: true, decoder: 'budget', l1Match: budget.result() }, l1: null };
  return { l0: r.l0, l1: r.l1 };
}

/// The worst outbound (Layer 0/1) verdict over `texts`, in one worker round trip.
export async function screenEach(texts: string[], budget: ScanBudget): Promise<DetectionResult> {
  const r = await budgeted<Extract<ScanResult, { op: 'outbound-each' }>>({ op: 'outbound-each', texts, ms: 0 }, budget);
  return r ? r.result : budget.result();
}

export async function redactText(text: string): Promise<string> {
  const r = await submit({ op: 'redact', text }, OTHER_OP_TIMEOUT_MS);
  if (r.op !== 'redact') throw new Error('scan worker: wrong reply');
  return r.redacted;
}

/// redactValue(value).redacted, in a worker. The value goes as JSON (key order kept).
export async function redactValueText(value: unknown): Promise<string> {
  const r = await submit({ op: 'redact-value', json: JSON.stringify(value) ?? 'null' }, OTHER_OP_TIMEOUT_MS);
  if (r.op !== 'redact-value') throw new Error('scan worker: wrong reply');
  return r.redacted;
}

export async function modelForms(json: string, skip: string[]): Promise<{ json: string; leaves: string }> {
  const r = await submit({ op: 'model-forms', json, skip }, OTHER_OP_TIMEOUT_MS);
  if (r.op !== 'model-forms') throw new Error('scan worker: wrong reply');
  return { json: r.json, leaves: r.leaves };
}

export async function decodeBlobInWorker(value: string, media?: { type: 'image' | 'audio'; mimeType: unknown }, mimeType?: unknown) {
  const r = await submit({ op: 'blob', value, media, mimeType }, OTHER_OP_TIMEOUT_MS);
  if (r.op !== 'blob') throw new Error('scan worker: wrong reply');
  return r.decoded;
}

/// True when operations run on the main thread because no worker could be started.
export function scanPoolInline(): boolean {
  return pool.inline;
}
