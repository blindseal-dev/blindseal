import { defineConfig, devices } from '@playwright/test';
// Runs e2e/live.spec.ts against a DEPLOYED site (no local server):
//   LIVE_URL=https://… pnpm exec playwright test -c playwright.live.config.ts
export default defineConfig({
  testDir: './e2e', testMatch: /live\.spec\.ts/, timeout: 60_000, reporter: [['list']],
  use: { baseURL: process.env.LIVE_URL ?? 'https://dv8pdxqyec.us-east-1.awsapprunner.com', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
