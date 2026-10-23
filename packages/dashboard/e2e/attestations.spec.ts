import { test, expect } from '@playwright/test';
const TOKEN = 'e2e0000000000000000000000000000000000000000000e2e';
test('attestations: list + detail sheet with 6 public inputs', async ({ page }) => {
  const off: string[] = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!['localhost','127.0.0.1',''].includes(h) && r.url().startsWith('http')) off.push(r.url()); } catch {} });
  await page.goto(`/#token=${TOKEN}`);
  await page.locator('.bs-navitem', { hasText: 'Attestations' }).click();
  await page.locator('.d05-table tbody tr').first().click(); // row 0 carries a real length-1 blob
  await expect(page.locator('.d05-sheet')).toBeVisible();
  // The single committed blob is decoded into the six labelled fields for display.
  await expect(page.locator('.d05-pi > div')).toHaveCount(6);
  // expirySlot renders as the decoded decimal (280050000), proving the blob was split, not passed through.
  await expect(page.locator('.d05-pi').getByText('280050000', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(off).toEqual([]);
});
