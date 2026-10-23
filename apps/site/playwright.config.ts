import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30_000, reporter: [['list']],
  use: { baseURL: 'http://localhost:3004' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // BLINDSEAL_RPC_URL=off: the explorer's server-side mainnet read is disabled in e2e (no network).
  webServer: { command: 'pnpm exec next start -p 3004', port: 3004, reuseExistingServer: false, timeout: 120_000, env: { BLINDSEAL_RPC_URL: 'off' } },
});
