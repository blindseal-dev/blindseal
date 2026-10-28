import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    // L2 embedding model load + warmup can take a few seconds on a cold WASM cache,
    // and integration tests spawn child processes that each pay this cost. The 5s
    // vitest default is enough in isolation but flakes under parallel-file load
    // (streaming tests + integration tests both hammer the WASM runtime).
    testTimeout: 20000,
    // Every proxy decision is appended to the audit chain (default ~/.blindseal). Keep test
    // runs — including the proxies they spawn, which inherit this env — out of the real home.
    env: { BLINDSEAL_AUDIT_DIR: path.join(os.tmpdir(), `blindseal-vitest-audit-${process.pid}`) },
  },
});
