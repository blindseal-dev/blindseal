import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';
test('settings: upstreams, detection, token rotate once-shown', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('a.bs-navitem', { hasText: 'Settings' }).click();
  await expect(page.locator('.d06-up')).toBeVisible();
  await page.locator('.d06-token__row .btn.secondary').click();
  await expect(page.locator('.d06-token__row .mono')).toBeVisible();
  expect(off).toEqual([]);
});
