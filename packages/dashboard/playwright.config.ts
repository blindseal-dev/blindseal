import { defineConfig, devices } from '@playwright/test';

const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1, // one shared mock server (also serving dist/ for served.spec); keep files serial
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5319', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // The mock also serves the BUILT dashboard at / (application/wasm + CSP) for served.spec.ts.
    { command: 'pnpm -C ../proxy exec tsx ../dashboard/test/mock.mjs', port: 4831, reuseExistingServer: !process.env.CI, env: { PORT: '4831', TOKEN, BLINDSEAL_DASHBOARD_DIST: new URL('./dist', import.meta.url).pathname }, timeout: 60_000 },
    { command: 'pnpm exec vite --port 5319 --strictPort', port: 5319, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
});
export { TOKEN };
