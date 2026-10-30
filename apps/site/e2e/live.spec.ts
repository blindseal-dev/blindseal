import { test, expect } from '@playwright/test';
import { INIT, DIFF, chromeViolations } from './mismatch-lib';
// Acceptance on the DEPLOYED site (playwright.live.config.ts): the kit must be mounted after
// hydration. Measured, not eyeballed:
//   1. after scrolling to the bottom, .reveal elements at opacity 0 → must be 0
//   2. the pill nav (round 2): the header fixed, the glass pill with its backdrop-filter, the five route links
//      and the sliding pill, X and GitHub icon links (new tab, noopener) and nothing else on the right
//   3. the hero (round 2): the pinned hooks and the dial banner the kit mounts (img.hero__banner); no footer on any route
//   4. zero console errors across the routes
const ROUTES = ['/', '/how-it-works', '/verify', '/docs', '/docs/hashing', '/explorer', '/changelog'];

test('live: reveals, pill nav, banner hero, no footer, console', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.locator('.site-notch .notch__items').waitFor({ timeout: 20_000 });

  // 2) the pill nav (round 2): one glass pill, server-rendered, adopted by the kit
  const notch = await page.locator('.site-notch').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const bar = el.querySelector('.nav-pill.glass-bar') as HTMLElement | null;
    const bcs = bar ? getComputedStyle(bar) : null;
    const bf = (bcs?.backdropFilter || (bcs as any)?.webkitBackdropFilter || '') as string;
    const social = [...el.querySelectorAll('[data-site-social]')].map((a) => ({ id: a.getAttribute('data-site-social'), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }));
    return { position: cs.position, bar: !!bar, backdrop: bf, pill: !!el.querySelector('.nav-pill .notch__pill'), items: el.querySelectorAll('.nav-pill__links > a.notch__item').length, social, cta: el.querySelectorAll('[data-site-cta]').length, footer: !!document.querySelector('.site-footer') };
  });
  expect(notch.position, 'header position').toBe('fixed');
  expect(notch.bar, 'the glass pill').toBe(true);
  expect(notch.backdrop && notch.backdrop !== 'none', `pill backdrop-filter (${notch.backdrop})`).toBe(true);
  expect(notch.pill, 'the sliding white pill').toBe(true);
  expect(notch.items, 'five route links').toBe(5);
  // the right side: X and GitHub icon links only, each in a new tab with rel noopener; no text action
  expect(notch.social).toEqual([
    { id: 'x', href: 'https://x.com/blindsealtech', target: '_blank', rel: 'noopener' },
    { id: 'github', href: 'https://github.com/blindseal-dev/blindseal', target: '_blank', rel: 'noopener' },
  ]);
  expect(notch.cta, 'no action button').toBe(0);

  // 3) the hero: the pinned hooks and the dial banner the kit mounts into the space (no CRT, no nebula).
  //    The kit writes the banner src from its own script URL, so it is absolute on the deployed site: compare the path.
  const hero = await page.locator('.hero.hero--pinned .hero__space').first().evaluate((host) => {
    const img = host.querySelector('img.hero__banner') as HTMLImageElement | null;
    return { bg: host.getAttribute('data-bg'), banner: !!img, src: img ? new URL(img.getAttribute('src') ?? '', location.href).pathname : null, canvas: !!host.querySelector('canvas'), reveal: !!host.parentElement?.querySelector('.hero__reveal video.hm-light__video') };
  });
  expect(hero.bg, `hero: ${JSON.stringify(hero)}`).toBe('banner');
  expect(hero.banner && hero.src === '/kit/brand/banner-dial.webp', `hero banner: ${JSON.stringify(hero)}`).toBe(true);
  expect(hero.canvas, 'no CRT / nebula canvas in the banner hero').toBe(false);
  expect(hero.reveal, 'the scroll-scrubbed clip element').toBe(true);

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
    expect(counts.footer, `a footer rendered on ${r} (round 2: none)`).toBe(false);
    expect(counts.hidden, `${r}: ${counts.hidden}/${counts.total} .reveal still at opacity 0`).toBe(0);
  }
  // 4) console
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  console.log(`      hidden reveals per route: ${JSON.stringify(hidden)} · header fixed=${notch.position === 'fixed'} pill backdrop=${notch.backdrop} · hero banner=${hero.banner} · console errors=${errors.length}`);
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
