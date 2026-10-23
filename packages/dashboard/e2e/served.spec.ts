import { test, expect } from '@playwright/test';
// The production path: the proxy serves the BUILT dashboard (dist/) at its own origin. The verify
// page must load the wasm verifier under the proxy's CSP (`script-src 'self' 'wasm-unsafe-eval'`)
// and the module must be served as application/wasm. Zero egress still holds: same origin.
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';
test.use({ baseURL: 'http://127.0.0.1:4831' });

test('served by the proxy: wasm verifier runs under the CSP, application/wasm, zero egress', async ({ page }) => {
  const off: string[] = [];
  const wasmTypes: string[] = [];
  let csp: string | null = null;
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost', '127.0.0.1', ''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) wasmTypes.push(r.headers()['content-type'] ?? '');
    if (new URL(r.url()).pathname === '/') csp = r.headers()['content-security-policy'] ?? null;
  });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-app').waitFor();
  expect(csp, 'document carries a CSP').toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
  await page.evaluate(() => { location.hash = '#/verify'; });
  await page.locator('.s03-drop').waitFor();
  await page.getByRole('button', { name: 'Load sample' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Valid', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Load tampered' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Invalid');
  await expect(page.locator('.s03-result')).toContainText('NotOnCurve');
  expect(wasmTypes, 'the .wasm was fetched and served as application/wasm').toEqual(['application/wasm']);
  expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
});
