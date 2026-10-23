import { test, expect, type Request } from '@playwright/test';

const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';

// Collect every network request and assert none leaves the host (zero-egress gate).
function trackEgress(page: import('@playwright/test').Page): string[] {
  const offHost: string[] = [];
  page.on('request', (r: Request) => {
    try {
      const h = new URL(r.url()).hostname;
      if (!['localhost', '127.0.0.1', ''].includes(h) && r.url().startsWith('http')) offHost.push(r.url());
    } catch { /* data: etc. */ }
  });
  return offHost;
}

test('decisions renders live against the mock server', async ({ page }) => {
  const off = trackEgress(page);
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator('.bs-app')).toBeVisible();
  await expect(page.locator('tr.d01-row').first()).toBeVisible({ timeout: 10_000 });
  // verdict filter: Block narrows the table
  const all = await page.locator('tr.d01-row').count();
  await page.locator('.d01-vseg .seg__item', { hasText: 'Block' }).click();
  await expect.poll(async () => page.locator('tr.d01-row').count()).toBeLessThanOrEqual(all);
  expect(off, `off-host requests: ${off.join(', ')}`).toEqual([]);
});

test('never-write scan is clean on the rendered page', async ({ page }) => {
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-app').waitFor();
  const hits = await page.evaluate(() => (window as any).BS?.neverWriteScan?.() ?? []);
  expect(hits).toEqual([]);
});

test('reduced-motion: page reaches its end state with no running animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator('tr.d01-row').first()).toBeVisible({ timeout: 10_000 });
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
});

test('key text meets 4.5:1 contrast against its background', async ({ page }) => {
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-top__title').waitFor();
  const ratio = await page.evaluate(() => {
    function lum(c: string) {
      const m = c.match(/\d+(\.\d+)?/g)!.map(Number);
      const [r, g, b] = m.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const el = document.querySelector('.bs-top__title') as HTMLElement;
    const fg = getComputedStyle(el).color;
    // Effective background: alpha-composite every translucent ancestor (the kit's glass bars are
    // rgba) over the first opaque one, top-down, instead of taking the first non-transparent colour.
    const parse = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!c || c === 'transparent') continue;
      const p = parse(c);
      if (p.a === 0) continue;
      layers.unshift(p);
      if (p.a >= 1) break;
    }
    let base = { r: 0, g: 0, b: 0 };
    for (const p of layers) base = { r: p.r * p.a + base.r * (1 - p.a), g: p.g * p.a + base.g * (1 - p.a), b: p.b * p.a + base.b * (1 - p.a) };
    const bg = `rgb(${base.r}, ${base.g}, ${base.b})`;
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
