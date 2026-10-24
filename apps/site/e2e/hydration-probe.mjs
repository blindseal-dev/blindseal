// node apps/site/e2e/hydration-probe.mjs <baseUrl> [route ...]   — zero pageerror + console errors, both viewports,
// listeners attached BEFORE goto, waitUntil:'load'; prints the first .reveal.is-inview time (must be < 500 ms).
import { chromium } from 'playwright';
const [base = 'http://127.0.0.1:3000', ...only] = process.argv.slice(2);
const ROUTES = only.length ? only : ['/', '/how-it-works', '/verify', '/docs', '/docs/hashing', '/explorer', '/changelog', '/dashboard'];
const b = await chromium.launch(); let bad = 0;
for (const vp of [{ width: 1440, height: 900 }, { width: 443, height: 714 }]) for (const r of ROUTES) {
  const page = await b.newPage({ viewport: vp }); const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message ?? e).split('\n')[0].slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().split('\n').slice(0, 2).join(' ⏎ ').slice(0, 300)); });
  await page.goto(base + r, { waitUntil: 'load' });
  const t0 = Date.now();
  const inview = await page.waitForSelector('.reveal.is-inview', { timeout: 3000 }).then(() => Date.now() - t0).catch(() => null);
  await page.waitForTimeout(1200);
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter((el) => getComputedStyle(el).opacity === '0' && el.getBoundingClientRect().top < innerHeight).length);
  const line = `${vp.width}x${vp.height} ${r.padEnd(14)} errors=${errs.length} firstInview=${inview === null ? 'none' : inview + 'ms'} hiddenAboveFold=${hidden}`;
  console.log(line); for (const e of [...new Set(errs)].slice(0, 3)) console.log('   ' + e);
  if (errs.length || hidden) bad++;
  await page.close();
}
await b.close(); process.exit(bad ? 1 : 0);
