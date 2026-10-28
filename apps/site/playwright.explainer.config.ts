import { defineConfig, devices } from '@playwright/test';
// The explainer's acceptance (e2e/explainer.spec.ts) against an already-running build:
//   BASE_URL=http://127.0.0.1:3013 pnpm exec playwright test -c playwright.explainer.config.ts
// Chromium and WebKit, each at 1440 × 900 (desktop) and 390 × 844 (phone).
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3013';
const desk = { viewport: { width: 1440, height: 900 } };
const phone = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
export default defineConfig({
  testDir: './e2e', testMatch: /explainer\.spec\.ts/, timeout: 60_000, reporter: [['list']],
  fullyParallel: true, workers: 4,
  use: { baseURL: BASE_URL },
  projects: [
    { name: 'chromium-1440', use: { ...devices['Desktop Chrome'], ...desk, browserName: 'chromium' } },
    { name: 'webkit-1440', use: { ...devices['Desktop Safari'], ...desk, browserName: 'webkit' } },
    { name: 'chromium-390', use: { ...phone, browserName: 'chromium' } },
    { name: 'webkit-390', use: { ...phone, browserName: 'webkit' } },
  ],
});
