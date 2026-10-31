import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INVISIBLE_TEXT } from './nojs-lib';

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
  // the kit paints the idle checklist (five pending steps) once it has mounted
  await expect(page.locator('#vf-checks .check')).toHaveCount(5);
  await page.getByRole('button', { name: 'Try a valid proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Proof verified');
  await expect(page.locator('#vf-banner .vf-banner__end')).toHaveText('4 of 4');
  await expect(page.locator('#vf-checks .check').nth(1)).toHaveAttribute('data-state', 'pass');
  // step 3 decoded the single public-input blob into its six fields
  await expect(page.locator('#vf-checks .vf-kv .kv__item')).toHaveCount(7);
  // step 4 rehashed the action fields (WebCrypto) to the committed action hash
  await expect(page.locator('#vf-checks .check').nth(3)).toHaveAttribute('data-state', 'pass');
  await expect(page.locator('#vf-checks .check').nth(3)).toContainText('rehash to the committed action fingerprint');
  // step 5 is on demand; the e2e server runs with BLINDSEAL_RPC_URL=off, so the same-origin read says unavailable
  await page.locator('#vf-checks [data-n4]').click();
  await expect(page.locator('#vf-checks .check').nth(4)).toHaveAttribute('data-state', 'fail', { timeout: 10_000 });
  await expect(page.locator('#vf-checks .check').nth(4)).toContainText('RPC unavailable');
  // 0.7.1: an edited action field (amount + 1) passes steps 1–3 — the proof and its labels are intact — and fails step 4
  const sample = JSON.parse(readFileSync(join(__dirname, '../app/verify/sample.json'), 'utf8'));
  for (const edit of [{ amount: String(BigInt(sample.action.amount) + 1n) }, { recipient: '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf' }, { mint: '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf' }, { sourceAuthority: '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf' }, { targetProgram: '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf' }]) {
    const edited = JSON.stringify({ ...sample, action: { ...sample.action, ...edit } });
    await page.evaluate((j) => (window as any).S03.verifyText(j, 'edited.json'), edited);
    await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'fail', { timeout: 20_000 });
    await expect(page.locator('#vf-banner .vf-banner__sub')).toContainText('Failed at step 4, Action matches the proof.');
    await expect(page.locator('#vf-checks .check').nth(2)).toHaveAttribute('data-state', 'pass');
    await expect(page.locator('#vf-checks .check').nth(3)).toHaveAttribute('data-state', 'fail');
    await expect(page.locator('#vf-checks .check').nth(3)).toContainText('action fields hash to');
    await expect(page.locator('#vf-checks .check').nth(4)).toHaveAttribute('data-state', 'skip');
  }
  // a file without action fields: step 4 is skipped with a reason, the proof still verifies
  const { action: _a, ...noAction } = sample;
  await page.evaluate((j) => (window as any).S03.verifyText(j, 'no-action.json'), JSON.stringify(noAction));
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await expect(page.locator('#vf-banner .vf-banner__end')).toHaveText('3 of 4');
  await expect(page.locator('#vf-checks .check').nth(3)).toHaveAttribute('data-state', 'skip');
  await expect(page.locator('#vf-checks .check').nth(3)).toContainText('no action fields');
  await page.getByRole('button', { name: 'Try an altered proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'fail', { timeout: 20_000 });
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Does not verify');
  // The real Groth16 verifier ran: a flipped proof fails the on-curve check at step 2; 3, 4 and 5 are skipped.
  await expect(page.locator('#vf-checks .check').nth(1)).toHaveAttribute('data-state', 'fail');
  await expect(page.locator('#vf-checks .check').nth(1)).toContainText('NotOnCurve');
  await expect(page.locator('#vf-checks .check').nth(2)).toHaveAttribute('data-state', 'skip');
  await expect(page.locator('#vf-checks .check').nth(3)).toHaveAttribute('data-state', 'skip');
  await expect(page.locator('#vf-checks .check').nth(4)).toHaveAttribute('data-state', 'skip');
  // a pasted disclosure.json is accepted too (ed25519 + chain recompute, in the browser)
  const disclosure = readFileSync(join(__dirname, '../app/verify/disclosure-sample.json'), 'utf8');
  await page.locator('#vf-text').fill(disclosure);
  await page.locator('#vf-verify').click();
  await expect(page.locator('#vf-checks .check').nth(2)).toHaveAttribute('data-state', 'pass', { timeout: 15_000 });
  await expect(page.locator('#vf-checks .check').nth(2)).toContainText('recomputed from their six fields');
  await expect(page.locator('#vf-banner .vf-banner__title')).toHaveText('Valid disclosure');
  await expect(page.locator('#vf-checks .check')).toHaveCount(4); // a disclosure has its own four steps
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
});

// ── progressive enhancement: with JavaScript off every route shows its content (no reveal stuck at 0) ──
test.describe('javascript disabled', () => {
  test.use({ javaScriptEnabled: false });
  for (const path of PAGES) {
    test(`${path}: content visible without JS`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      const hidden: string[] = await page.evaluate(INVISIBLE_TEXT);
      expect(hidden, `invisible text without JS:\n${hidden.slice(0, 10).join('\n')}`).toEqual([]);
      // and the reveals specifically: rendered at full opacity
      const reveals: number[] = await page.$$eval('.reveal', (els) => els.map((e) => Number(getComputedStyle(e).opacity)));
      expect(reveals.every((o) => o === 1), `reveal opacities ${reveals.join(',')}`).toBe(true);
    });
  }
});

// ── a Nullifier consumed DIRECTLY (consumer_program = Pubkey::default()) is not "by 1111…" ──
test('verify step 5: a direct consumption reads "consumed directly (no gated program)"', async ({ page }) => {
  await page.route('**/verify/nullifier*', (r) => r.fulfill({ json: { nullifier: '0x' + '00'.repeat(32), consumed: true, pda: 'x', consumedAtSlot: 460579127, consumerProgram: '11111111111111111111111111111111', direct: true, cluster: 'mainnet-beta', rpc: 'configured' } }));
  await page.goto('/verify');
  await expect(page.locator('#vf-checks .check')).toHaveCount(5);
  await page.getByRole('button', { name: 'Try a valid proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await page.locator('#vf-checks [data-n4]').click();
  const step4 = page.locator('#vf-checks .check').nth(4);
  await expect(step4).toHaveAttribute('data-state', 'pass', { timeout: 10_000 });
  await expect(step4).toContainText('consumed directly (no gated program)');
  await expect(step4).not.toContainText('by');
  await expect(step4.locator('.hash')).toHaveCount(0);
});
test('verify step 5: a gated consumption still names its program', async ({ page }) => {
  await page.route('**/verify/nullifier*', (r) => r.fulfill({ json: { nullifier: '0x' + '00'.repeat(32), consumed: true, pda: 'x', consumedAtSlot: 460579127, consumerProgram: '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa', cluster: 'mainnet-beta', rpc: 'configured' } }));
  await page.goto('/verify');
  await expect(page.locator('#vf-checks .check')).toHaveCount(5);
  await page.getByRole('button', { name: 'Try a valid proof', exact: true }).click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await page.locator('#vf-checks [data-n4]').click();
  const step4 = page.locator('#vf-checks .check').nth(4);
  await expect(step4).toHaveAttribute('data-state', 'pass', { timeout: 10_000 });
  await expect(step4).toContainText('by');
  await expect(step4.locator('.hash')).toHaveAttribute('data-hash', '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa');
  await expect(step4).not.toContainText('consumed directly');
});
