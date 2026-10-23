import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';

test('row → decision detail renders its sections', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('tr.d01-row').first().click();
  await expect(page.locator('.d02-head')).toBeVisible();
  await expect(page.locator('.d02-layers')).toBeVisible();
  await expect(page.locator('.d02-hashes')).toBeVisible();
  expect(off).toEqual([]);
});
