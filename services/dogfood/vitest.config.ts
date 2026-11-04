import { defineConfig } from 'vitest/config';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The dry-run tests spawn the real proxy. Everything it would write by default (audit chain, manifest
// cache, prover times) resolves through HOME, so HOME points at a throwaway dir: no test can touch the
// real ~/.blindseal. BLINDSEAL_RPC_URL=off disables every mainnet read in the proxy's CLI, so a test that
// accidentally reached a live step would fail instead of talking to the network.
const TEST_HOME = path.join(os.tmpdir(), `blindseal-dogfood-vitest-home-${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });

export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Each dry-run tick starts a proxy that loads the layer-2 model; one file at a time keeps that
    // deterministic on a loaded machine.
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
    env: {
      HOME: TEST_HOME,
      XDG_CACHE_HOME: path.join(TEST_HOME, '.cache'),
      BLINDSEAL_AUDIT_DIR: path.join(TEST_HOME, '.blindseal-audit'),
      BLINDSEAL_RPC_URL: 'off',
    },
  },
});
