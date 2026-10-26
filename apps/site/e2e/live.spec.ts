import { test, expect } from '@playwright/test';
import { INIT, DIFF, chromeViolations } from './mismatch-lib';
// Acceptance on the DEPLOYED site (playwright.live.config.ts): the kit must be mounted after
// hydration. Measured, not eyeballed:
//   1. after scrolling to the bottom, .reveal elements at opacity 0 → must be 0
//   2. the notch nav: computed position fixed, backdrop-filter set
//   3. the hero has a canvas with a live WebGL2 context (the CRT), or an explicit nebula fallback
//   4. zero console errors across the routes
const ROUTES = ['/', '/how-it-works', '/verify', '/docs', '/docs/hashing', '/explorer', '/changelog'];

test('live: reveals, notch, CRT hero, console', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.locator('.site-notch .notch__items').waitFor({ timeout: 20_000 });

  // 2) the notch
  const notch = await page.locator('.site-notch').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const inner = el.querySelector('.notch') as HTMLElement | null;
    const ics = inner ? getComputedStyle(inner) : null;
    const bf = (ics?.backdropFilter || (ics as any)?.webkitBackdropFilter || cs.backdropFilter || (cs as any).webkitBackdropFilter || '') as string;
    return { position: cs.position, backdrop: bf, wings: el.querySelectorAll('.notch__wing').length, pill: !!el.querySelector('.notch__pill'), items: el.querySelectorAll('.notch__item').length };
  });
  expect(notch.position, 'notch position').toBe('fixed');
  // The mockups mount nav:"notch" — opaque tabs on the 8px frame (site.css: backdrop-filter only in
  // the alternative nav:"glass" mode, .site-notch--glass .notch.glass-bar). Accept either: notch
  // mode must have the wings + pill; glass mode must have the backdrop-filter.
  const glassMode = await page.locator('.site-notch').first().evaluate((el) => el.classList.contains('site-notch--glass'));
  if (glassMode) expect(notch.backdrop && notch.backdrop !== 'none', `glass notch backdrop-filter (${notch.backdrop})`).toBe(true);
  else expect(notch.wings, 'notch wings (notch mode)').toBeGreaterThanOrEqual(2);
  expect(notch.pill, 'notch pill').toBe(true);
  expect(notch.items).toBeGreaterThanOrEqual(5);

  // the notch's primary action: Docs (GitHub once the repo is public); the dashboard is local-only and not linked
  const cta = page.locator('[data-site-cta]').first();
  await expect(cta).toHaveAttribute('href', 'https://github.com/blindseal-dev/blindseal');

  // 3) the hero: CRT canvas with WebGL2 (or the nebula fallback declared on the host)
  const hero = await page.locator('.hero__space').first().evaluate((host) => {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement | null;
    let webgl2 = false;
    try { webgl2 = !!(canvas && canvas.getContext('webgl2')); } catch { webgl2 = false; }
    return { canvas: !!canvas, webgl2, bg: host.getAttribute('data-bg') };
  });
  const headlessNoGl = !hero.canvas && hero.bg === 'nebula';
  expect(hero.canvas && hero.webgl2 || headlessNoGl, `hero: ${JSON.stringify(hero)}`).toBe(true);

  // 1) reveals on every route after scrolling to the bottom
  const hidden: Record<string, number> = {};
  for (const r of ROUTES) {
    await page.goto(r);
    // .site-notch is a height-0 fixed host (site.css); the visible part is its tabs
    await page.locator('.site-notch .notch__items').waitFor({ timeout: 20_000 });
    await page.evaluate(async () => {
      const step = Math.max(200, Math.floor(innerHeight * 0.6));
      for (let y = 0; y <= document.body.scrollHeight + step; y += step) { scrollTo(0, y); await new Promise((res) => setTimeout(res, 120)); }
      scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(900);
    const counts = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.reveal')] as HTMLElement[];
      const hid = all.filter((el) => parseFloat(getComputedStyle(el).opacity) === 0);
      return { total: all.length, hidden: hid.length, footer: !!document.querySelector('.site-footer') };
    });
    hidden[r] = counts.hidden;
    expect(counts.footer, `footer rendered on ${r}`).toBe(true);
    expect(counts.hidden, `${r}: ${counts.hidden}/${counts.total} .reveal still at opacity 0`).toBe(0);
  }
  // 4) console
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  console.log(`      hidden reveals per route: ${JSON.stringify(hidden)} · notch fixed=${notch.position === 'fixed'} backdrop=${notch.backdrop} · hero canvas=${hero.canvas} webgl2=${hero.webgl2} · console errors=${errors.length}`);
});

// 5) hydration, captured rather than inferred (owner's acceptance): the DOM React hydrates against
//    (outerHTML at DOMContentLoaded) diffed at full fidelity against the DOM 5 s later, plus every
//    console.error / reportError / window error mentioning 418/423/hydration. Asserted on all seven
//    routes, at 1440×900 and 443×714, normal / CPU ×6 / frozen lifecycle (background-tab emulation):
//      · __errs empty in every variant
//      · kit blocked: the diff is EMPTY (React's server and client trees agree)
//      · kit running: no insertion or attribute change on <html>, <head> or any direct child of <body> —
//        the chrome is server-rendered and the kit only adopts it. Deeper, post-mount page.js work
//        (odometer cells, <i> → <svg>, aria-current, absolute copy links, "Updated Ns ago") is allowed.
for (const vp of [{ width: 1440, height: 900 }, { width: 443, height: 714 }]) for (const load of ['normal', 'CPU×6', 'frozen'] as const) for (const kit of [false, true]) {
  test(`live: no hydration mismatch ${vp.width}x${vp.height} ${load} ${kit ? 'kit' : 'no-kit'}`, async ({ browser }) => {
    test.setTimeout(300_000);
    for (const r of ROUTES) {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      await page.addInitScript(INIT);
      if (!kit) await page.route('**/kit/kit.js', (route) => route.abort());
      const cdp = await ctx.newCDPSession(page);
      if (load === 'CPU×6') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      if (load === 'frozen') {
        await page.goto(r, { waitUntil: 'commit' });
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => {});
        await new Promise((res) => setTimeout(res, 8000));
        await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
        await page.waitForLoadState('load');
      } else await page.goto(r, { waitUntil: 'load' });
      await page.waitForTimeout(5000);
      const res = await page.evaluate(`(${DIFF})(${JSON.stringify(kit)})`) as { errs: string[]; diff: { at?: string; kind?: string }[] };
      expect(res.errs, `${r} __errs`).toEqual([]);
      if (!kit) expect(res.diff, `${r} pre/post DOM diff`).toEqual([]);
      else {
        expect(chromeViolations(res.diff), `${r} html/head/body-children changes by the kit`).toEqual([]);
        expect(await page.evaluate(() => document.body.hasAttribute('data-kit-mounted')), `${r} kit mounted`).toBe(true);
      }
      await ctx.close();
    }
  });
}
