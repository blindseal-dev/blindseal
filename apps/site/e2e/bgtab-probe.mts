// node e2e/bgtab-probe.mts <baseUrl> [--throttle] [routes…] — headed: page A loads the route while page B
// (same context) is brought to front immediately, so A loads with visibilityState hidden; 8 s later A's
// __errs (console.error / reportError / error naming 418/423/hydration) are read.
import { chromium } from 'playwright';
import { INIT, ROUTES } from './mismatch-lib.ts';
const args = process.argv.slice(2); const base = args.shift()!; const THR = args.includes('--throttle');
const routes = args.filter((a) => a.startsWith('/')); if (!routes.length) routes.push(...ROUTES);
const b = await chromium.launch({ headless: false }); let bad = 0;
for (const r of routes) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await ctx.newPage(); await A.addInitScript(INIT);
  if (THR) { const cdp = await ctx.newCDPSession(A); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 }); }
  const B = await ctx.newPage(); await B.goto('about:blank');
  const nav = A.goto(base + r, { waitUntil: 'commit' }); await B.bringToFront(); await nav;
  await B.waitForTimeout(8000);
  const vis = await A.evaluate(() => document.visibilityState);
  const res = await A.evaluate(() => ({ errs: (window as any).__errs as string[], kit: document.documentElement.hasAttribute('data-kit-mounted') }));
  console.log(`${THR ? 'cpu×6' : 'norm '} ${r.padEnd(14)} visibility=${vis} errs=${res.errs.length} kitMounted=${res.kit}`); for (const e of res.errs.slice(0, 3)) console.log('   ERR ' + e);
  if (res.errs.length) bad++; await ctx.close();
}
await b.close(); process.exit(bad ? 1 : 0);
