// Screenshot-diff the shipped pages against design/mockups at 1440×900 → docs/visual-diff/.
//   LIVE_URL=https://… DASH_URL=http://127.0.0.1:4831 node scripts/visual-diff.mjs
// Pairs: S01–S06 (site routes vs mockups/S0x/index.html) and D01 (dashboard /decisions vs
// mockups/D01/index.html). Both sides: same viewport, fonts ready, scrolled to top, motion settled
// (full motion, 2.5 s). Writes <name>-mockup.png, <name>-live.png, <name>-diff.png and a README
// table with the differing-pixel percentage (pixelmatch, threshold 0.1).
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'visual-diff');
const LIVE = process.env.LIVE_URL ?? 'https://blindseal.tech';
const DASH = process.env.DASH_URL ?? 'http://127.0.0.1:4831';
const TOKEN = process.env.DASH_TOKEN ?? 'e2e0000000000000000000000000000000000000000000e2e';
const mock = (p) => 'file://' + join(ROOT, 'design/mockups/mockups', p);
const PAIRS = [
  ['S01-home', mock('S01/index.html'), `${LIVE}/`],
  ['S02-how-it-works', mock('S02/index.html'), `${LIVE}/how-it-works`],
  ['S03-verify', mock('S03/index.html'), `${LIVE}/verify`],
  ['S04-docs', mock('S04/index.html'), `${LIVE}/docs`],
  ['S05-explorer', mock('S05/index.html'), `${LIVE}/explorer`],
  ['S06-changelog', mock('S06/index.html'), `${LIVE}/changelog`],
  ['D01-decisions', mock('D01/index.html'), `${DASH}/#token=${TOKEN}`],
];
const W = 1440, H = 900;

async function shoot(browser, url) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(2500); // first-paint cover, hero rise, odometers
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  const buf = await page.screenshot({ fullPage: false });
  await page.close();
  return { png: PNG.sync.read(buf), errors };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const rows = [];
for (const [name, a, b] of PAIRS) {
  const m = await shoot(browser, a), l = await shoot(browser, b);
  const diff = new PNG({ width: W, height: H });
  const n = pixelmatch(m.png.data, l.png.data, diff.data, W, H, { threshold: 0.1, includeAA: false });
  const pct = (100 * n / (W * H)).toFixed(2);
  writeFileSync(join(OUT, `${name}-mockup.png`), PNG.sync.write(m.png));
  writeFileSync(join(OUT, `${name}-live.png`), PNG.sync.write(l.png));
  writeFileSync(join(OUT, `${name}-diff.png`), PNG.sync.write(diff));
  rows.push({ name, pct, errors: l.errors.length });
  console.log(`${name.padEnd(18)} differing pixels ${pct}%  (live page errors: ${l.errors.length})`);
}
await browser.close();
const date = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT, 'README.md'), `# Visual diff — shipped pages vs design/mockups (${date})

1440×900, first screen, full motion settled (2.5 s), fonts ready, scrolled to top. Differing pixels
by \`pixelmatch\` (threshold 0.1). Live = ${LIVE} (site) and the dashboard served by the proxy.

| Pair | Differing pixels | Files |
|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.pct}% | \`${r.name}-mockup.png\` · \`${r.name}-live.png\` · \`${r.name}-diff.png\` |`).join('\n')}

Expected, by construction: the mockups render synthetic fixtures (counts, hashes, timestamps) and the
live pages render the mock API's fixtures or mainnet data, so copy/number differences show as
pixels; the explorer differs most when it reads mainnet live. Structural differences (missing
sections, chrome, backgrounds) are what to read these for.
`);
console.log(`wrote ${rows.length} pairs → docs/visual-diff/`);
