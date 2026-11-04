import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { INVISIBLE_TEXT } from './nojs-lib';

const PAGES = ['/', '/how-it-works', '/verify', '/docs', '/docs/concepts', '/docs/hashing', '/docs/integrate', '/docs/scope', '/docs/source', '/docs/hosted-prover', '/explorer', '/explorer?tab=treasury', '/changelog'];

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

// ── the explorer's Treasury tab ──────────────────────────────────────────────────────────────────
// The default server has no BLINDSEAL_TREASURY: the tab renders its "not configured" state. The tabs are
// links without JS and an in-place switch with the kit mounted; either way nothing leaves the host.
const offHost = (page: import('@playwright/test').Page) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost', '127.0.0.1', ''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  return off;
};
test('explorer treasury tab: not configured; the switch is in place and the URL keeps the tab', async ({ page }) => {
  const off = offHost(page);
  await page.goto('/explorer');
  await page.waitForSelector('body[data-kit-mounted]');
  await expect(page.locator('#ex-tabs .tab-text')).toHaveCount(2);
  await expect(page.locator('#ex-tab-attestations')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ex-treasury')).toBeHidden();
  await expect(page.locator('h1')).toHaveText('Attestations on mainnet.');
  await page.locator('#ex-tab-treasury').click();
  await expect(page.locator('#ex-treasury')).toBeVisible();
  await expect(page.locator('#ex')).toBeHidden();
  await expect(page.locator('#ex-tab-treasury')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('h1')).toHaveText('Treasury on mainnet.');
  await expect(page.locator('#ex-treasury [data-treasury="unconfigured"]')).toContainText('Treasury not configured');
  await expect(page.locator('#ex-treasury .ex-tr-stats')).toHaveCount(0);
  await expect(page).toHaveURL(/\/explorer\?tab=treasury$/);
  await page.locator('#ex-tab-attestations').click();
  await expect(page.locator('#ex')).toBeVisible();
  await expect(page.locator('#ex-treasury')).toBeHidden();
  await expect(page).toHaveURL(/\/explorer$/);
  expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
});
test('explorer ?tab=treasury: the server renders the tab selected', async ({ page }) => {
  await page.goto('/explorer?tab=treasury');
  await expect(page.locator('h1')).toHaveText('Treasury on mainnet.');
  await expect(page.locator('#ex-tab-treasury')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ex-treasury')).toBeVisible();
  await expect(page.locator('#ex')).toBeHidden();
  await expect(page.locator('#ex-treasury [data-treasury="unconfigured"]')).toBeVisible();
  // the JSON the Retry would read: not configured, nothing read, no error
  const snap = await (await page.request.get('/explorer/treasury')).json();
  expect(snap).toMatchObject({ configured: false, live: false, rows: [] });
  expect(snap.error).toBeUndefined();
});
test.describe('explorer treasury tab without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the tabs are links and the not-configured state is server-rendered', async ({ page }) => {
    await page.goto('/explorer');
    await expect(page.locator('#ex-treasury')).toBeHidden();
    await page.locator('#ex-tab-treasury').click();   // a plain navigation
    await expect(page).toHaveURL(/\/explorer\?tab=treasury$/);
    await expect(page.locator('#ex-treasury [data-treasury="unconfigured"]')).toBeVisible();
    await expect(page.locator('#ex')).toBeHidden();
    const hidden: string[] = await page.evaluate(INVISIBLE_TEXT);
    expect(hidden, hidden.join('\n')).toEqual([]);
  });
});

// Configured (BLINDSEAL_TREASURY set) with BLINDSEAL_RPC_URL=off: a second standalone server from the same
// build, on a free port; the tab shows the offline block — no rows, no totals — and Retry re-reads same-origin.
test.describe('explorer treasury tab, configured with mainnet reads off', () => {
  const TREASURY = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';   // a synthetic key: nothing is read with RPC off
  let site: ChildProcess | undefined, BASE = '';
  const freePort = () => new Promise<number>((resolve, reject) => {
    const s = netServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  });
  test.beforeAll(async () => {
    const server = join(__dirname, '../.next/standalone/apps/site/server.js');
    if (!existsSync(server)) throw new Error('no standalone build');
    const port = await freePort(); BASE = `http://127.0.0.1:${port}`;
    site = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', BLINDSEAL_RPC_URL: 'off', BLINDSEAL_TREASURY: TREASURY }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('site did not start');
  });
  test.afterAll(() => { site?.kill(); });
  test('the tab shows the offline block with no rows, and Retry stays same-origin', async ({ page }) => {
    const off = offHost(page);
    await page.goto(BASE + '/explorer?tab=treasury');
    await expect(page.locator('#ex-treasury')).toHaveAttribute('data-view', 'offline');
    const block = page.locator('#ex-treasury [data-treasury="offline"]');
    await expect(block).toBeVisible();
    await expect(block).toContainText('Mainnet reads are off');
    await expect(block).toContainText('No treasury rows to show');
    await expect(block).toContainText('Attempt 1 · cluster mainnet · RPC_OFF');
    await expect(page.locator('#ex-treasury .ex-tx')).toHaveCount(0);
    await expect(page.locator('#ex-treasury .ex-tr-stats')).toHaveCount(0);
    await page.waitForSelector('body[data-kit-mounted]');
    await page.locator('#ex-tr-retry').click();
    await expect(page.locator('#ex-treasury [data-treasury="offline"]')).toContainText('Attempt 2 · cluster mainnet · RPC_OFF', { timeout: 10_000 });
    const snap = await (await page.request.get(BASE + '/explorer/treasury')).json();
    expect(snap).toMatchObject({ configured: true, live: false, treasury: TREASURY, rows: [], error: { code: 'RPC_OFF' } });
    expect(off, `off-host: ${off.join(', ')}`).toEqual([]);
  });
});

// ── the home FAQ has no token question and the site has no "No token" line ──────────────────────
test('home FAQ: eight questions, none about a token; "No token" appears nowhere on the page', async ({ page }) => {
  await page.goto('/');
  const qs = page.locator('.hm-faq__item summary');
  await expect(qs).toHaveCount(8);
  expect((await qs.allTextContents()).filter((q) => /token/i.test(q))).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bno token\b/i);
  expect(text).not.toMatch(/is there a token/i);
});

// ── 0.8.0: L0 inside the proof is stated with the "pending mainnet" marker, and the old wording is gone ──
for (const path of ['/how-it-works', '/docs/scope', '/docs/concepts', '/docs']) {
  test(`${path}: L0-in-proof sentences carry the pending-mainnet badge; no "not in proof yet"`, async ({ page }) => {
    await page.goto(path);
    const badges = page.locator('[data-pending-mainnet]');
    expect(await badges.count()).toBeGreaterThanOrEqual(1);
    await expect(badges.first()).toHaveText('pending mainnet');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/not (in|inside) (the )?proof yet|L0 next|L1 today/i);
  });
}
