// The explorer with DATA, deterministic and offline: a mock Solana JSON-RPC (in this process) answers the
// verifier's reads with one gated consumption (transfer-gate) and two DIRECT ones (consumer_program =
// Pubkey::default()); a second standalone server (the same build, BLINDSEAL_RPC_URL → the mock) serves the
// page. Asserts: direct submissions are not a consumer program (metric, list, foot) and get their own line;
// with JavaScript off the lists, the per-day table and every reveal are server-rendered and visible.
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { INVISIBLE_TEXT } from './nojs-lib';

const RPC_PORT = 3018, SITE_PORT = 3017, BASE = `http://127.0.0.1:${SITE_PORT}`;
const GATE = '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Buffer {
  let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
const disc = (p: string) => createHash('sha256').update(p).digest().subarray(0, 8);
const nullifier = (consumer: Buffer, slot: number) => {
  const b = Buffer.alloc(81); disc('account:Nullifier').copy(b, 0); b.writeBigUInt64LE(BigInt(slot), 8); consumer.copy(b, 16); b.fill(0xab, 48, 80); return b.toString('base64');
};
const event = (nf: number, consumer: Buffer) => {
  const b = Buffer.alloc(136); disc('event:Consumed').copy(b, 0); b.fill(nf, 8, 40); b.fill(0x36, 72, 104); consumer.copy(b, 104); return 'Program data: ' + b.toString('base64');
};
const now = Math.floor(Date.now() / 1000), SLOT = 470_000_000;
const ZERO = Buffer.alloc(32), GATE_B = b58decode(GATE);
function answer(method: string): unknown {
  if (method === 'getSlot') return SLOT;
  if (method === 'getProgramAccounts') return [
    { pubkey: 'P1', account: { data: [nullifier(GATE_B, SLOT - 100), 'base64'] } },
    { pubkey: 'P2', account: { data: [nullifier(ZERO, SLOT - 50), 'base64'] } },
    { pubkey: 'P3', account: { data: [nullifier(ZERO, SLOT - 10), 'base64'] } },
  ];
  if (method === 'getSignaturesForAddress') return [{ signature: 'S1', slot: SLOT - 100, blockTime: now - 3600, err: null }];
  if (method === 'getTransaction') return { slot: SLOT - 100, blockTime: now - 3600, meta: { err: null, logMessages: [event(1, GATE_B), event(2, ZERO), event(3, ZERO)] } };
  throw new Error('unexpected ' + method);
}

let rpc: Server, site: ChildProcess;
test.beforeAll(async () => {
  rpc = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const { method } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answer(method) }));
    });
  });
  await new Promise<void>((r) => rpc.listen(RPC_PORT, '127.0.0.1', r));
  // the default suite's webServer (serve-standalone) has already copied static + public beside the build
  const server = path.join(__dirname, '../.next/standalone/apps/site/server.js');
  if (!existsSync(server)) throw new Error('no standalone build');
  site = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(SITE_PORT), HOSTNAME: '127.0.0.1', BLINDSEAL_RPC_URL: `http://127.0.0.1:${RPC_PORT}` }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('site did not start');
});
test.afterAll(async () => { site?.kill(); await new Promise<void>((r) => rpc.close(() => r())); });

test('explorer: direct submissions are not counted as a consumer program', async ({ page }) => {
  await page.goto(BASE + '/explorer');
  await expect(page.locator('#ex')).toHaveAttribute('data-view', 'ready');
  // an odometer's value is its screen-reader text once the kit has mounted it (the visible digits are
  // aria-hidden tick cells, so textContent reads "33"), and its plain text before that
  const odo = (k: string) => page.locator(`[data-odo="${k}"]`).evaluate((e) => (e.querySelector('.sr-only') ?? e).textContent);
  await expect.poll(() => odo('total')).toBe('3');
  await expect.poll(() => odo('programs'), { timeout: 10_000 }).toBe('1');
  const rows = page.locator('#ex-programs-rows .ex-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.hash')).toHaveAttribute('data-hash', GATE);
  await expect(page.locator('#ex-programs-rows [data-hash="11111111111111111111111111111111"]')).toHaveCount(0);
  await expect(page.locator('#ex-programs-foot')).toHaveText('1 programs · 0 without a public name · sums to 1');
  await expect(page.locator('#ex-programs-direct')).toBeVisible();
  await expect(page.locator('#ex-programs-direct')).toHaveText('2 direct submissions (no gated program)');
  await expect(page.locator('#ex-lists')).not.toContainText('1111');
});

test.describe('explorer without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('lists, per-day table and reveals are server-rendered and visible', async ({ page }) => {
    await page.goto(BASE + '/explorer');
    await expect(page.locator('#ex-roots-rows .ex-row')).toHaveCount(1);
    await expect(page.locator('#ex-roots-rows .ex-row').first()).toBeVisible();
    await expect(page.locator('#ex-programs-rows .ex-row')).toHaveCount(1);
    await expect(page.locator('#ex-programs-rows .ex-row').first()).toBeVisible();
    await expect(page.locator('[data-odo="programs"]')).toHaveText('1');
    await expect(page.locator('#ex-programs-direct')).toHaveText('2 direct submissions (no gated program)');
    await expect(page.locator('#ex-table tbody tr')).toHaveCount(30);
    await expect(page.locator('#ex-table')).toBeVisible();
    const hidden: string[] = await page.evaluate(INVISIBLE_TEXT);
    expect(hidden, hidden.join('\n')).toEqual([]);
  });
});
