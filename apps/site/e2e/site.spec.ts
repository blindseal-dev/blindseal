import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = ['/', '/how-it-works', '/verify', '/docs', '/docs/concepts', '/docs/hashing', '/docs/integrate', '/docs/scope', '/docs/source', '/explorer', '/changelog'];

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


test('verify: sample valid, tampered invalid, disclosure accepted, nothing stored, wasm fetched same-origin', async ({ page }) => {
  const off: string[] = [];
  // This is the only test that triggers the lazy wasm fetch — assert it stays same-origin.
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto('/verify');
  // the kit paints the idle checklist (four pending steps) once it has mounted
  await expect(page.locator('#vf-checks .check')).toHaveCount(4);
  await page.getByRole('button', { name: 'Try a valid proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Proof verified');
  await expect(page.locator('#vf-checks .check').nth(1)).toHaveAttribute('data-state', 'pass');
  // step 3 decoded the single public-input blob into its six fields
  await expect(page.locator('#vf-checks .vf-kv .kv__item')).toHaveCount(7);
  // step 4 is on demand; the e2e server runs with BLINDSEAL_RPC_URL=off, so the same-origin read says unavailable
  await page.locator('#vf-checks [data-n4]').click();
  await expect(page.locator('#vf-checks .check').nth(3)).toHaveAttribute('data-state', 'fail', { timeout: 10_000 });
  await expect(page.locator('#vf-checks .check').nth(3)).toContainText('RPC unavailable');
  await page.getByRole('button', { name: 'Try an altered proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'fail', { timeout: 20_000 });
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Does not verify');
  // The real Groth16 verifier ran: a flipped proof fails the on-curve check at step 2; 3 and 4 are skipped.
  await expect(page.locator('#vf-checks .check').nth(1)).toHaveAttribute('data-state', 'fail');
  await expect(page.locator('#vf-checks .check').nth(1)).toContainText('NotOnCurve');
  await expect(page.locator('#vf-checks .check').nth(2)).toHaveAttribute('data-state', 'skip');
  // a pasted disclosure.json is accepted too (ed25519 + chain recompute, in the browser)
  const disclosure = readFileSync(join(__dirname, '../app/verify/disclosure-sample.json'), 'utf8');
  await page.locator('#vf-text').fill(disclosure);
  await page.locator('#vf-verify').click();
  await expect(page.locator('#vf-checks .check').nth(2)).toHaveAttribute('data-state', 'pass', { timeout: 15_000 });
  await expect(page.locator('#vf-checks .check').nth(2)).toContainText('recomputed from their six fields');
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Valid disclosure');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
});
