// Renders the site's brand files ONCE (run by hand, commit the output; the Docker build has no browser):
//   public/og-image.png                               1200×630, scripts/brand/og.html (kit fonts, tokens, nebula);
//                                                     og:image + twitter:image on every page via app/meta.ts
//   app/icon.svg                                      the mark (circle + bar on #060510), = scripts/brand/mark.svg
//   app/favicon.ico                                   16 / 32 / 48 px PNGs packed into one ICO
//   app/apple-icon.png + public/apple-touch-icon.png  180×180, full-bleed (iOS rounds the corners itself)
// Next's metadata file conventions serve the icons (/favicon.ico, /icon.svg, /apple-icon.png) with the right
// content-type and emit the icon tags on every page.
// Usage: node scripts/render-brand.mjs   (needs `node scripts/bundle-kit.mjs` first, for public/kit/kit.js)
import { chromium } from 'playwright';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const at = (...p) => path.join(root, ...p);
const mark = readFileSync(at('scripts/brand/mark.svg'), 'utf8').trim();

const b = await chromium.launch();
// 1. og:image
{
  const page = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(at('scripts/brand/og.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
  writeFileSync(at('public/og-image.png'), png);
  await page.close();
}
// 2. the mark as PNGs
async function markPng(size, fullBleed) {
  const svg = fullBleed ? mark.replace(' rx="16"', '') : mark;
  const page = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
  const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}
writeFileSync(at('app/icon.svg'), mark + '\n');
const apple = await markPng(180, true);
writeFileSync(at('app/apple-icon.png'), apple);
copyFileSync(at('app/apple-icon.png'), at('public/apple-touch-icon.png'));   // the literal path some clients probe
// ICO: ICONDIR (6 bytes) + one 16-byte ICONDIRENTRY per image + the PNG payloads (PNG-in-ICO, Vista+)
const sizes = [16, 32, 48], pngs = [];
for (const s of sizes) pngs.push(await markPng(s, false));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12);
  off += pngs[i].length;
});
writeFileSync(at('app/favicon.ico'), Buffer.concat([head, ...pngs]));
await b.close();
console.log('brand files written');
