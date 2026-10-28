/// Layer 2 worker: the embedding model (layer2-embeddings.ts), off the event loop.

import { parentPort } from 'node:worker_threads';
import { runLayer2Op, type Layer2Op } from './layer2-embeddings.js';

parentPort?.on('message', (req: Layer2Op) => {
  runLayer2Op(req).then(
    (r) => parentPort!.postMessage({ ok: true, ...r }),
    (err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

// Modules are loaded: the pool may send requests.
parentPort?.postMessage({ ready: true });
