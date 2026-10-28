/// Scan worker: the CPU-bound screening steps (scan-ops.ts), off the event loop. scan-pool.ts runs
/// a pool of these. Imports nothing that loads the model layers.

import { parentPort } from 'node:worker_threads';
import { runScanOp, type ScanOp } from './scan-ops.js';

parentPort?.on('message', (req: ScanOp) => {
  try {
    parentPort!.postMessage({ ok: true, ...runScanOp(req) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Modules are loaded: the pool may send tasks (start-up time never counts against a deadline).
parentPort?.postMessage({ ready: true });
