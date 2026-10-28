import { defineConfig, devices } from '@playwright/test';
// E2E_PORT: serve the standalone build on another port (default 3004) when 3004 is taken.
const PORT = process.env.E2E_PORT || '3004';
export default defineConfig({
  testDir: './e2e', testIgnore: /(live|mobile|explainer)\.spec\.ts/, timeout: 30_000, reporter: [['list']], // live / mobile / explainer specs run via playwright.live / .mobile / .explainer.config.ts
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // BLINDSEAL_RPC_URL=off: the explorer's server-side mainnet read is disabled in e2e (no network).
  webServer: { command: 'node scripts/serve-standalone.mjs', port: Number(PORT), reuseExistingServer: false, timeout: 120_000, env: { BLINDSEAL_RPC_URL: 'off', PORT } },
});
