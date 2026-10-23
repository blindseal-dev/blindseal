import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30_000, reporter: [['list']],
  use: { baseURL: 'http://localhost:3004' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'pnpm exec next start -p 3004', port: 3004, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
