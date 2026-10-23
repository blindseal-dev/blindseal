import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';

test('audit: head, verify chain intact, entries render', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-navitem', { hasText: 'Audit' }).click();
  await expect(page.locator('.d03-head')).toBeVisible();
  await page.locator('.d03-vbtn').click();
  await expect(page.locator('.d03-v.is-ok')).toBeVisible();
  await expect(page.locator('.d03-entries tbody tr').first()).toBeVisible();
  expect(off).toEqual([]);
});
