// Phone acceptance (owner's mobile spec, < 720 px). Run with playwright.mobile.config.ts against a
// production build (BASE_URL). Per route: no horizontal overflow (top and bottom), a single header row
// ≤ 56 px that hides the page behind it at every scroll position, no rendered text under 12 px (HTML via
// computed font-size; SVG via font-size × the element's screen scale), every visible interactive element
// ≥ 44 × 44, zero console errors / page errors. Plus the menu sheet, the contents control and /verify.
// Screenshots: SHOTS=1 writes docs/visual-diff/mobile/<engine>-<width>-<route>.png (explicit widths).
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = ['/', '/how-it-works', '/verify', '/docs', '/docs/hashing', '/docs/integrate', '/docs/scope', '/docs/source', '/explorer', '/changelog'];
const SHOT_DIR = join(__dirname, '../../../docs/visual-diff/mobile');

function watchErrors(page: Page) {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}
async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForSelector('body[data-kit-mounted]', { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}
const overflow = (page: Page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));

// every text run that is actually laid out: its rendered size in CSS px
const SMALL_TEXT = () => {
  const out: string[] = [];
  const vis = (el: Element) => (el as HTMLElement).checkVisibility ? (el as HTMLElement).checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as never) : true;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || '').trim(); const el = n.parentElement;
    if (!t || !el || seen.has(el)) continue; seen.add(el);
    if (el.closest('script, style, noscript, template, title, [hidden]')) continue;
    if (!vis(el)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;                                  // not laid out / sr-only clip
    const cs = getComputedStyle(el);
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue;
    let px = parseFloat(cs.fontSize);
    if (el instanceof SVGElement) {
      const g = el as unknown as SVGGraphicsElement; const m = g.getScreenCTM?.();
      if (m) px *= Math.sqrt(m.a * m.a + m.b * m.b);
    }
    if (px < 11.95) out.push(`${px.toFixed(2)}px <${el.tagName.toLowerCase()}${el.getAttribute('class') ? '.' + el.getAttribute('class')!.split(/\s+/).join('.') : ''}> "${t.slice(0, 40)}"`);
  }
  return out;
};
// visible interactive elements under 44 × 44 CSS px
const SMALL_TARGETS = () => {
  const out: string[] = [];
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
  document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as never)) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const fixed = getComputedStyle(el).position === 'fixed';
    const top = fixed ? r.top : r.top + scrollY;
    if (top + r.height <= 0 || r.right <= 0 || r.left >= innerWidth) return;   // parked off-screen (the skip link)
    if (r.width < 43.5 || r.height < 43.5) out.push(`${Math.round(r.width)}×${Math.round(r.height)} <${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).join('.') : ''}> "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
  });
  return out;
};
// the header's row: every point must hit the header (solid, full width, nothing beside/behind it)
const HEADER_LEAKS = () => {
  const h = document.querySelector('header.site-notch') as HTMLElement; const r = h.getBoundingClientRect();
  const bad: string[] = [];
  if (r.left > 0.5 || Math.abs(r.right - innerWidth) > 0.5) bad.push(`header spans ${r.left}..${r.right} of ${innerWidth}`);
  const bg = getComputedStyle(h).backgroundColor; if (!/^rgb\(/.test(bg)) bad.push(`header background ${bg} is not opaque`);
  for (const y of [1, r.height / 2, r.height - 1]) for (let x = 1; x < innerWidth; x += 6) {
    const el = document.elementFromPoint(x, y);
    if (!el || !h.contains(el)) { bad.push(`(${x},${Math.round(y)}) → ${el ? el.tagName.toLowerCase() + '.' + String(el.className && typeof el.className === 'string' ? el.className : '') : 'null'}`); if (bad.length > 6) return bad; }
  }
  return bad;
};

for (const path of ROUTES) {
  test(`${path}`, async ({ page }, info) => {
    const errs = watchErrors(page);
    await open(page, path);
    const vw = page.viewportSize()!.width;
    expect(vw).toBeLessThan(720);

    // header: one row, ≤ 56 px, a solid bar across the full width; the desktop tabs are gone
    const hh = await page.evaluate(() => (document.querySelector('header.site-notch') as HTMLElement).getBoundingClientRect().height);
    expect.soft(hh, 'header height').toBeLessThanOrEqual(56);
    expect.soft(hh, 'header height').toBeGreaterThan(40);
    await expect.soft(page.locator('.notch--center')).toBeHidden();
    await expect.soft(page.locator('.site-frame')).toBeHidden();
    await expect.soft(page.locator('[data-site-menu-btn]')).toBeVisible();

    // no horizontal overflow at the top
    let o = await overflow(page);
    expect.soft(o.sw, 'scrollWidth at top').toBe(o.iw);

    // the page behind the header, at several scroll positions; then overflow again at the bottom
    const H = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    for (const f of [0, 0.2, 0.45, 0.7, 1]) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), Math.round(H * f));
      await page.waitForTimeout(250);
      expect.soft(await page.evaluate(HEADER_LEAKS), `header leaks at ${Math.round(f * 100)}%`).toEqual([]);
      // the floating back-to-top button (rail pages), once shown, sits at the bottom of the viewport
      if (f > 0) expect.soft(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.hiw-toc__top, .docs-otp__top, .cl-rail__top')]
        .filter((b) => b.checkVisibility({ visibilityProperty: true } as never)).map((b) => Math.round(innerHeight - b.getBoundingClientRect().bottom))
        .filter((gap) => gap < 0 || gap > 80)), 'back-to-top off the bottom edge').toEqual([]);
    }
    await page.waitForTimeout(300);
    o = await overflow(page);
    expect.soft(o.sw, 'scrollWidth at bottom').toBe(o.iw);

    // text and targets (measured after the whole page has been scrolled through, reveals settled)
    expect.soft(await page.evaluate(SMALL_TEXT), 'text under 12px').toEqual([]);
    expect.soft(await page.evaluate(SMALL_TARGETS), 'targets under 44px').toEqual([]);

    if (process.env.SHOTS && /^chromium-|^webkit-/.test(info.project.name) && /-(360|390|430)$/.test(info.project.name)) {
      mkdirSync(SHOT_DIR, { recursive: true });
      const engine = info.project.name.split('-')[0];
      const slug = path === '/' ? 'home' : path.slice(1).replace(/\//g, '-');
      // walk the page so every reveal and figure has drawn, then shoot from the top
      for (let y = 0; y <= H; y += 300) { await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y); await page.waitForTimeout(120); }
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForFunction(() => window.scrollY === 0); await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOT_DIR, `${engine}-${vw}-${slug}.png`), fullPage: true, scale: 'css', animations: 'disabled' });
    }
    expect.soft(errs, 'console / page errors').toEqual([]);
  });
}

test('menu sheet: opens, lists the routes, traps focus, Escape closes and returns focus', async ({ page }) => {
  const errs = watchErrors(page);
  await open(page, '/');
  const btn = page.locator('[data-site-menu-btn]');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  const sheetId = await btn.getAttribute('aria-controls');
  const sheet = page.locator(`#${sheetId}`);
  await expect(sheet).toBeHidden();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet).toBeVisible();
  for (const name of ['How it works', 'Verify', 'Docs', 'Explorer', 'Changelog', 'GitHub']) await expect(sheet.getByRole('link', { name, exact: true })).toBeVisible();
  // full screen
  const box = await sheet.boundingBox(); const vp = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1); expect(box!.y + box!.height).toBeGreaterThanOrEqual(vp.height - 1);
  // focus moved into the sheet and stays there (Tab and Shift+Tab wrap)
  const inMenu = () => page.evaluate(() => { const a = document.activeElement; return !!a && (!!a.closest('[data-site-menu]') || a.hasAttribute('data-site-menu-btn')); });
  expect(await inMenu()).toBe(true);
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); expect(await inMenu()).toBe(true); }
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Shift+Tab'); expect(await inMenu()).toBe(true); }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-site-menu-btn'))).toBe(true);
  // a route link navigates and the sheet is closed on the new page
  await btn.click();
  await sheet.getByRole('link', { name: 'Verify', exact: true }).click();
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.locator(`#${sheetId}`)).toBeHidden();
  expect(errs).toEqual([]);
});

test('how-it-works: contents is a collapsed sticky control that expands and tracks the section', async ({ page }) => {
  const errs = watchErrors(page);
  await open(page, '/how-it-works');
  const toggle = page.locator('[data-hiw-toc-toggle]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.hiw-toc__list')).toBeHidden();
  // sticky: still under the header after scrolling into the body of the page
  const secs = page.locator('.hiw-sec');
  await secs.nth(3).scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
  const tb = await toggle.boundingBox(); const hh = await page.evaluate(() => (document.querySelector('header.site-notch') as HTMLElement).getBoundingClientRect().bottom);
  expect(tb!.y).toBeGreaterThanOrEqual(hh - 1); expect(tb!.y).toBeLessThan(hh + 24);
  const label = (await toggle.textContent())!;
  const active = await page.locator('.hiw-toc__link.is-active').first().textContent();
  expect(label).toContain((active || '').replace(/^\s*\d+/, '').trim().slice(0, 12));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.hiw-toc__list')).toBeVisible();
  await page.locator('.hiw-toc__link').nth(1).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(errs).toEqual([]);
});

test('verify: the two tries come first, the textarea is 3 rows until focused, results scroll into view', async ({ page }) => {
  const errs = watchErrors(page);
  await open(page, '/verify');
  const ok = page.getByRole('button', { name: 'Try a valid proof', exact: true });
  const bad = page.getByRole('button', { name: 'Try an altered proof', exact: true });
  await expect(ok).toBeVisible(); await expect(bad).toBeVisible();
  const drop = await page.locator('#vf-drop').boundingBox();
  expect((await ok.boundingBox())!.y).toBeLessThan(drop!.y);
  expect((await bad.boundingBox())!.y).toBeLessThan(drop!.y);
  const ta = page.locator('#vf-text');
  const rows = async () => page.evaluate(() => { const t = document.getElementById('vf-text') as HTMLTextAreaElement; const cs = getComputedStyle(t); return (t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight); });
  expect(await rows()).toBeLessThanOrEqual(3.2);
  await ta.focus();
  await expect.poll(rows).toBeGreaterThan(5);
  await ta.blur();
  await ok.click();
  await expect(page.locator('#vf-banner')).toHaveAttribute('data-tone', 'pass', { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => { const r = document.getElementById('vf-banner')!.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; })).toBe(true);
  expect(errs).toEqual([]);
});
