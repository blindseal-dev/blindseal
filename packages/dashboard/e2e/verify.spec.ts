import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';

test('verify: sample passes, tampered fails, nothing stored, zero egress', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);           // capture token on first load
  await page.locator('.bs-app').waitFor();
  await page.evaluate(() => { location.hash = '#/verify'; }); // in-app nav, token kept in memory
  await page.locator('.s03-drop').waitFor();
  await page.getByRole('button', { name: 'Load sample' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Valid');
  await page.getByRole('button', { name: 'Load tampered' }).click();
  await expect(page.locator('.s03-result .panel__title')).toHaveText('Invalid');
  const ls = await page.evaluate(() => localStorage.length);
  expect(ls).toBe(0);
  expect(off).toEqual([]);
});
