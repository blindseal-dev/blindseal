// node e2e/mismatch-probe.mts <baseUrl> [--kit] [--throttle] [routes…]
// Captures the DOM React hydrates against (document.documentElement.outerHTML at DOMContentLoaded, via
// addInitScript) and diffs it, attribute by attribute, against the DOM 5 s later. Default: /kit/kit.js is
// blocked, so the post-DOM is React's own work only and the diff IS the server/client disagreement.
// --kit lets the kit run and excludes what it creates. __errs collects console.error / reportError /
// window 'error' entries mentioning 418, 423 or "hydrat".
import { chromium } from 'playwright';
import { INIT, DIFF, ROUTES, chromeViolations, outsideLauncher } from './mismatch-lib.ts';
const args = process.argv.slice(2); const base = args.shift();
const KIT = args.includes('--kit'), THR = args.includes('--throttle');
const routes = args.filter((a) => a.startsWith('/')); if (!routes.length) routes.push(...ROUTES);
const b = await chromium.launch(); let bad = 0;
for (const vp of [{ width: 1440, height: 900 }, { width: 443, height: 714 }]) for (const r of routes) {
  const ctx = await b.newContext({ viewport: vp }); const page = await ctx.newPage();
  await page.addInitScript(INIT);
  if (!KIT) await page.route('**/kit/kit.js', (route) => route.abort());
  if (THR) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 }); }
  await page.goto(base + r, { waitUntil: 'load' }); await page.waitForTimeout(5000);
  const res = await page.evaluate(`(${DIFF})(${JSON.stringify(KIT)})`);
  const n = res.diff ? (r === '/dashboard' && !KIT ? outsideLauncher(res.diff) : res.diff).length : -1; const v = KIT && res.diff ? chromeViolations(res.diff).length : 0;
  console.log(`${KIT ? 'kit ' : 'nokit'} ${THR ? 'cpu×6' : 'norm '} ${vp.width}x${vp.height} ${r.padEnd(14)} errs=${(res.errs || []).length} diff=${n}${KIT ? ' chromeViolations=' + v : ''}${res.error ? ' ' + res.error : ''}`);
  for (const e of (res.errs || []).slice(0, 3)) console.log('   ERR ' + e);
  for (const d of (KIT ? chromeViolations(res.diff || []) : (res.diff || [])).slice(0, 12)) console.log('   ' + JSON.stringify(d));
  if ((res.errs || []).length || (KIT ? v !== 0 : n !== 0)) bad++;
  await ctx.close();
}
await b.close(); process.exit(bad ? 1 : 0);
