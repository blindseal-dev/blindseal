import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

import { mkdirSync } from 'node:fs';

const TEST_HOME = path.join(os.tmpdir(), `blindseal-vitest-home-${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });

export default defineConfig({
  test: {
    // L2 embedding model load + warmup can take a few seconds on a cold WASM cache,
    // and integration tests spawn child processes that each pay this cost. The 5s
    // vitest default is enough in isolation but flakes under parallel-file load
    // (streaming tests + integration tests both hammer the WASM runtime).
    testTimeout: 20000,
    hookTimeout: 60000,
    // test/edge-cases.test.ts holds the CPU-bound load scenarios (a 500 KB streaming scan,
    // 1000 back-to-back calls through L2); `pnpm test` runs it on its own after the rest so its
    // timing budgets measure the proxy, not contention with other files.
    // Many files spawn real proxies (each loads the layer-2 model at startup and runs a child
    // MCP server). Running one file per core starves those children of CPU and turns readiness
    // into a race against fixed timeouts; half the cores keeps the suite deterministic.
    poolOptions: { forks: { maxForks: Math.max(2, Math.floor(os.cpus().length / 2)), minForks: 1 } },
    // Every proxy decision is appended to the audit chain (default ~/.blindseal), and the
    // dashboard token, scans.db, attest records and manifest cache all resolve through HOME.
    // Point HOME itself at a throwaway dir so no test — nor any proxy it spawns, which inherits
    // this env — can touch the real ~/.blindseal, even one that forgets to set its own dirs.
    env: {
      HOME: TEST_HOME,
      XDG_CACHE_HOME: path.join(TEST_HOME, '.cache'),
      BLINDSEAL_AUDIT_DIR: path.join(TEST_HOME, '.blindseal-audit'),
    },
  },
});
