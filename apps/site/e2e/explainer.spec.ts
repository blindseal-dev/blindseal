// The explainer's acceptance (/lab/explainer), run by playwright.explainer.config.ts against a production
// build: Chromium + WebKit at 1440 and 390. Zero console errors; the server HTML is exactly what the client
// hydrates (no diff before the clock's first tick); plays in view and stops its rAF offscreen, in a hidden tab
// and on pause; every chapter dot works from the keyboard; the reduced-motion storyboard; quarter speed; no text
// under 12 px inside the explainer; no horizontal overflow; never-write clean on every string (all chapters,
// transcript, storyboard, the timeline's exported copy); content and transcript without JS.
import { test, expect, type Page } from '@playwright/test';
import { INIT, DIFF } from './mismatch-lib';
import { INVISIBLE_TEXT } from './nojs-lib';
import { CHAPTERS, TAG, END_LINE, PRINTS, ADDR } from '../app/explainer/timeline';

const PATH = '/lab/explainer';

function watchErrors(page: Page) {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __explainerRaf?: number }).__explainerRaf ?? 0);
const still = async (page: Page, ms = 600) => { const a = await frames(page); await page.waitForTimeout(ms); return (await frames(page)) - a; };

// rendered text runs under 12 px inside the explainer (HTML: computed size; SVG: × screen scale)
const SMALL_TEXT = (sel: string) => {
  const out: string[] = [];
  const root = document.querySelector(sel)!;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = (n.textContent || '').trim(); const el = n.parentElement;
    if (!t || !el || el.closest('script, style, noscript')) continue;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as never)) continue;
    const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    let px = parseFloat(getComputedStyle(el).fontSize);
    if (el instanceof SVGElement) { const m = (el as unknown as SVGGraphicsElement).getScreenCTM?.(); if (m) px *= Math.sqrt(m.a * m.a + m.b * m.b); }
    if (px < 11.95) out.push(`${px.toFixed(2)}px "${t.slice(0, 40)}"`);
  }
  // pseudo-element labels (the pips' passed / blocked / skipped)
  root.querySelectorAll('.ex-pip').forEach((p) => { const px = parseFloat(getComputedStyle(p, '::after').fontSize); if (px < 11.95) out.push(`${px}px ::after`); });
  return out;
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('server HTML = the client DOM before the first tick; zero console errors', async ({ page }) => {
  const errs = watchErrors(page);
  await page.addInitScript(INIT);
  // the clock never starts: no IntersectionObserver callback ever arrives; the kit is blocked (React's work only)
  await page.addInitScript(() => { (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }; });
  await page.route('**/kit/kit.js', (r) => r.abort());
  await page.goto(PATH, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const res = await page.evaluate(`(${DIFF})(false)`) as { errs: string[]; diff: unknown[] };
  expect(res.errs, 'hydration errors').toEqual([]);
  expect(res.diff, 'server/client diff').toEqual([]);
  expect(await frames(page)).toBe(0);
  await expect(page.locator('.ex-frame')).toHaveAttribute('data-ch', '1');
  expect(errs.filter((e) => !/kit\.js|ERR_FAILED/.test(e))).toEqual([]);
});

test('plays in view; the rAF stops offscreen, in a hidden tab and on pause', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(PATH, { waitUntil: 'load' });
  await page.locator('.ex-frame').scrollIntoViewIfNeeded();
  await expect.poll(() => frames(page), { timeout: 5000 }).toBeGreaterThan(10);
  expect(await still(page, 400)).toBeGreaterThan(5);
  // offscreen: a tall spacer after the page, scrolled to the bottom
  await page.evaluate(() => { const d = document.createElement('div'); d.style.height = '4000px'; d.id = 'spacer'; document.body.appendChild(d); window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); });
  await page.waitForTimeout(300);
  expect(await still(page, 800), 'frames while offscreen').toBe(0);
  // back in view: resumes
  await page.locator('.ex-frame').scrollIntoViewIfNeeded();
  await expect.poll(() => still(page, 300), { timeout: 5000 }).toBeGreaterThan(3);
  // partly in view: 25 % of the stage (or of the viewport under the header, when the stage is taller) — stopped;
  // 60 % — running
  const place = (f: number) => page.evaluate((f) => {
    const st = document.querySelector('.ex-frame')!.getBoundingClientRect();
    const vis = f * Math.min(st.height, innerHeight - 64);
    window.scrollTo({ top: st.bottom + scrollY - 64 - vis, behavior: 'instant' });   // the stage's bottom edge under the header
  }, f);
  await place(0.25); await page.waitForTimeout(300);
  expect(await still(page, 800), 'frames with 25 % of the stage in view').toBe(0);
  await place(0.6);
  await expect.poll(() => still(page, 300), { timeout: 5000 }).toBeGreaterThan(3);
  // hidden tab
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(200);
  expect(await still(page, 800), 'frames in a hidden tab').toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => still(page, 300), { timeout: 5000 }).toBeGreaterThan(3);
  // pause (WCAG 2.2.2)
  const play = page.locator('.ex-play');
  await expect(play).toHaveAttribute('aria-label', 'Pause the explainer');
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Play the explainer');
  await page.waitForTimeout(200);
  expect(await still(page, 800), 'frames while paused').toBe(0);
  await play.click();
  await expect.poll(() => still(page, 300), { timeout: 5000 }).toBeGreaterThan(3);
  expect(errs).toEqual([]);
});

test('chapter dots: keyboard reachable, each shows its chapter; captions in a polite live region; nothing focusable inside the hidden stage', async ({ page, browserName }) => {
  // WebKit on macOS moves focus to buttons with Option+Tab (Tab alone reaches links and fields only)
  const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const errs = watchErrors(page);
  await page.goto(PATH, { waitUntil: 'load' });
  await expect(page.locator('.ex-stage')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('.ex-stage').evaluate((s) => s.querySelectorAll('a, button, input, [tabindex]').length)).toBe(0);
  const live = page.locator('.ex-cap__live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  // pause from the keyboard, then walk the dots with Tab and press Enter on each
  await page.locator('.ex-play').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ex-play')).toHaveAttribute('data-playing', '0');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(TAB);
    const dot = page.locator('.ex-dot').nth(i);
    await expect(dot).toBeFocused();
    await page.keyboard.press(i % 2 ? 'Space' : 'Enter');
    await expect(dot).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('.ex-dot[aria-current]')).toHaveCount(1);
    await expect(page.locator('.ex-frame')).toHaveAttribute('data-ch', String(i + 1));
    await expect(live.locator('.ex-cap__t')).toHaveText(CHAPTERS[i].title);
  }
  // chapter 6's still: the end card and its link are shown; elsewhere the link is not reachable
  const cta = page.getByRole('link', { name: 'Try a real proof' }).first();
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/verify');
  await page.locator('.ex-dot').nth(0).click();
  await expect(page.locator('.ex-end')).toBeHidden();
  // controls are ≥ 44 × 44
  for (const b of await page.locator('.ex-play, .ex-dot').all()) { const r = (await b.boundingBox())!; expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44); }
  expect(errs).toEqual([]);
});

test('every chapter: text ≥ 12 px inside the explainer, no horizontal overflow, never-write clean', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(PATH, { waitUntil: 'load' });
  await page.waitForSelector('body[data-kit-mounted]', { timeout: 20_000 });
  await page.locator('.ex-play').click();
  await page.locator('.ex-script summary').click();
  for (let i = 0; i < 6; i++) {
    await page.locator('.ex-dot').nth(i).click();
    await page.waitForTimeout(250);
    expect.soft(await page.evaluate(SMALL_TEXT, 'figure.ex'), `small text, chapter ${i + 1}`).toEqual([]);
    expect.soft(await overflow(page), `overflow, chapter ${i + 1}`).toBe(0);
    const hits = await page.evaluate(() => (window as any).BS.neverWriteScan());
    expect.soft(hits, `never-write, chapter ${i + 1}`).toEqual([]);
  }
  // every string the timeline exports, including the ones no single frame shows at once
  const all = [TAG, END_LINE, ...Object.values(ADDR), ...PRINTS.flat(), ...CHAPTERS.flatMap((c) => [c.title, c.text, c.scene])].join('\n');
  expect(await page.evaluate((t) => (window as any).BS.neverWriteScan(t), all)).toEqual([]);
  expect(errs).toEqual([]);
});

for (const how of ['media', 'query'] as const) {
  test(`reduced motion (${how}): the static six-frame storyboard, no clock`, async ({ page }) => {
    const errs = watchErrors(page);
    if (how === 'media') await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(PATH + (how === 'query' ? '?motion=reduce' : ''), { waitUntil: 'load' });
    await expect(page.locator('.ex-board > li')).toHaveCount(6);
    await expect(page.locator('.ex-live')).toHaveCount(0);
    await expect(page.locator('.ex-ctrl')).toHaveCount(0);
    for (let i = 0; i < 6; i++) await expect(page.locator('.ex-board > li').nth(i).locator('.ex-cap__t')).toHaveText(CHAPTERS[i].title);
    await page.waitForTimeout(500);
    expect(await still(page, 600)).toBe(0);
    expect.soft(await page.evaluate(SMALL_TEXT, 'figure.ex'), 'small text, storyboard').toEqual([]);
    expect.soft(await overflow(page), 'overflow, storyboard').toBe(0);
    await page.waitForSelector('body[data-kit-mounted]', { timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).BS.neverWriteScan())).toEqual([]);
    expect(errs).toEqual([]);
  });
}

test('?motion=slow plays at quarter speed', async ({ page }) => {
  await page.goto(PATH + '?motion=slow', { waitUntil: 'load' });
  await page.locator('.ex-frame').scrollIntoViewIfNeeded();
  await expect.poll(() => frames(page), { timeout: 5000 }).toBeGreaterThan(5);
  await page.waitForTimeout(4500);   // 4.5 s at ×0.25 ≈ 1.1 s of timeline: still chapter 1 (chapter 2 starts at 3.5 s)
  await expect(page.locator('.ex-frame')).toHaveAttribute('data-ch', '1');
  await page.goto(PATH, { waitUntil: 'load' });
  await page.locator('.ex-frame').scrollIntoViewIfNeeded();
  await expect(page.locator('.ex-frame')).toHaveAttribute('data-ch', '2', { timeout: 8000 });
});

test.describe('javascript disabled', () => {
  test.use({ javaScriptEnabled: false });
  test('chapter 1 and the transcript show; the controls are hidden', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.ex-task')).toContainText('Pay invoice #2041');
    await expect(page.locator('.ex-cap__live .ex-cap__t')).toHaveText(CHAPTERS[0].title);
    await expect(page.locator('.ex-ctrl')).toBeHidden();
    await expect(page.locator('.ex-end')).toBeHidden();
    const hidden: string[] = await page.evaluate(INVISIBLE_TEXT);
    expect(hidden).toEqual([]);
    await page.locator('.ex-script summary').click();
    for (const c of CHAPTERS) await expect(page.locator('.ex-script')).toContainText(c.title);
    await expect(page.locator('.ex-script a[href="/verify"]')).toBeVisible();
    expect(await overflow(page)).toBe(0);
  });
});
