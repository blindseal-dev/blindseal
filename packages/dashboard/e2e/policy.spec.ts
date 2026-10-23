import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';

test('policy: rules, toggle makes dirty, save recomputes root', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-navitem', { hasText: 'Policy' }).click();
  await expect(page.locator('.d04-rules tbody tr')).toHaveCount(22);
  const rootBefore = await page.locator('.d04-root__row .hash').first().getAttribute('data-hash');
  await page.locator('.d04-rules tbody tr input[type=checkbox]').first().uncheck();
  await page.locator('.d04-root button.primary').click();
  await expect.poll(async () => page.locator('.d04-root__row .hash').first().getAttribute('data-hash')).not.toBe(rootBefore);
  expect(off).toEqual([]);
});
