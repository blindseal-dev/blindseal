import { defineConfig, devices } from '@playwright/test';
// Phone acceptance (e2e/mobile.spec.ts) against an already-running build:
//   BASE_URL=http://127.0.0.1:3011 pnpm exec playwright test -c playwright.mobile.config.ts
// Chromium and WebKit, each with the iPhone 14 / iPhone 15 profiles and three explicit phone viewports.
// Desktop is covered by playwright.config.ts (site.spec.ts) and the 1440 visual diff.
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3011';
const phone = (width: number, height: number) => ({ viewport: { width, height }, screen: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const VIEWPORTS: [string, Record<string, unknown>][] = [
  ['iphone14', { ...devices['iPhone 14'] }],
  ['iphone15', { ...devices['iPhone 15'] }],
  ['360', phone(360, 780)],
  ['390', phone(390, 844)],
  ['430', phone(430, 932)],
];
export default defineConfig({
  testDir: './e2e', testMatch: /mobile\.spec\.ts/, timeout: 90_000, reporter: [['list']],
  fullyParallel: true, workers: 4,
  use: { baseURL: BASE_URL },
  projects: (['chromium', 'webkit'] as const).flatMap((engine) => VIEWPORTS.map(([name, use]) => {
    const { defaultBrowserType: _d, ...rest } = use as { defaultBrowserType?: string };
    return { name: `${engine}-${name}`, use: { ...rest, browserName: engine } };
  })),
});
