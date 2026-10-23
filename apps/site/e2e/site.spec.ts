import { test, expect } from '@playwright/test';

const PAGES = ['/', '/how-it-works', '/verify', '/docs', '/docs/concepts', '/docs/hashing', '/docs/integrate', '/docs/scope', '/explorer', '/changelog'];

for (const path of PAGES) {
  test(`${path}: renders, zero egress, never-write clean`, async ({ page }) => {
    const off: string[] = [];
    page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    const hits = await page.evaluate(() => (window as any).BS?.neverWriteScan?.() ?? []);
    expect(hits, `never-write: ${hits.join(', ')}`).toEqual([]);
    expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
  });
}

test('home reduced-motion reaches end state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => document.documentElement.setAttribute('data-motion', 'reduce'));
  await page.goto('/');
  await expect(page.locator('.hero__title')).toBeVisible();
  // reveal content settles at its end state (opacity 1), not stuck mid-entrance
  await expect.poll(async () => page.evaluate(() => {
    const el = document.querySelector('.s01-problem__line');
    return el ? Number(getComputedStyle(el).opacity) : 0;
  })).toBeGreaterThan(0.99);
});


test('verify: sample valid, tampered invalid, nothing stored, wasm fetched same-origin', async ({ page }) => {
  const off: string[] = [];
  // This is the only test that triggers the lazy wasm fetch — assert it stays same-origin.
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto('/verify');
  await page.getByRole('button', { name: 'Load sample' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Valid');
  await page.getByRole('button', { name: 'Load tampered' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Invalid');
  // The real Groth16 verifier ran: a flipped proof fails the on-curve check.
  await expect(page.locator('.s03-result')).toContainText('NotOnCurve');
  // a disclosure.json is accepted too (ed25519 + chain recompute, in the browser)
  await page.getByRole('button', { name: 'Load disclosure' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Valid', { timeout: 10_000 });
  await expect(page.locator('.s03-result')).toContainText('content-free entries');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
});
