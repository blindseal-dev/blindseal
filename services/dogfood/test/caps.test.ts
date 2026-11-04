/// The daily caps: pure accounting over the JSONL log, and a tick that stops before the proxy starts.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { checkCaps, spentInWindow } from '../src/ledger.js';
import { appendEntry, logPath, readEntries, type TickEntry } from '../src/log.js';
import { runTick } from '../src/tick.js';
import { dryRunConfig, tempDir } from './helpers.js';

const entry = (ts: string, spend: { lamports: number; usdcAtomic: number }, dryRun = true): TickEntry => ({
  ts, tick: 't', dryRun, status: 'ok', wallet: 'w', steps: {}, spend,
});

describe('ledger', () => {
  const now = new Date('2026-11-04T12:00:00Z');

  it('sums only the last 24 h and only entries of the same mode', () => {
    const entries = [
      entry('2026-11-03T11:00:00Z', { lamports: 5, usdcAtomic: 5 }),          // 25 h ago: out
      entry('2026-11-03T13:00:00Z', { lamports: 10, usdcAtomic: 100 }),       // 23 h ago: in
      entry('2026-11-04T11:00:00Z', { lamports: 20, usdcAtomic: 200 }),       // in
      entry('2026-11-04T11:30:00Z', { lamports: 1000, usdcAtomic: 1000 }, false), // live: not for a dry run
    ];
    expect(spentInWindow(entries, { now, dryRun: true })).toEqual({ lamports: 30n, usdcAtomic: 300n });
    expect(spentInWindow(entries, { now, dryRun: false })).toEqual({ lamports: 1000n, usdcAtomic: 1000n });
  });

  it('refuses a tick whose transfer (amount + overhead) would break the SOL cap', () => {
    const cfg = dryRunConfig('/tmp/unused', { maxSolPerDay: 0.005, transferLamports: 1_000_000, txOverheadLamports: 1_100_000 });
    // two ticks spent 4.2e6 lamports; a third needs 2.1e6 more > 5e6
    const entries = [entry('2026-11-04T06:00:00Z', { lamports: 2_100_000, usdcAtomic: 0 }), entry('2026-11-04T09:00:00Z', { lamports: 2_100_000, usdcAtomic: 0 })];
    const c = checkCaps(cfg, entries, now);
    expect(c.ok).toBe(false);
    expect(c.reasons[0]).toMatch(/SOL cap/);
  });

  it('bounds the purchase allowance by what is left of the USDC cap', () => {
    const cfg = dryRunConfig('/tmp/unused', { maxUsdcPerDay: 0.05, x402: { resourceUrl: '', maxPriceUsdc: 0.1, payToAllowlist: [] } });
    const c = checkCaps(cfg, [entry('2026-11-04T09:00:00Z', { lamports: 0, usdcAtomic: 30_000 })], now);
    expect(c.ok).toBe(true);
    expect(c.usdcAllowanceAtomic).toBe(20_000n);
    const spent = checkCaps(cfg, [entry('2026-11-04T09:00:00Z', { lamports: 0, usdcAtomic: 50_000 })], now);
    expect(spent.ok).toBe(false);
    expect(spent.reasons[0]).toMatch(/USDC cap/);
  });
});

describe('a capped tick', () => {
  it('is logged as capped and starts no proxy, buys nothing, sends nothing', async () => {
    const { dir, cleanup } = tempDir('caps');
    try {
      const cfg = dryRunConfig(dir, { maxSolPerDay: 0.002 });
      const file = logPath(cfg.dataDir);
      appendEntry(file, entry(new Date().toISOString(), { lamports: 2_100_000, usdcAtomic: 10_000 }));
      const t0 = Date.now();
      const e = await runTick(cfg, { log: () => undefined });
      expect(Date.now() - t0).toBeLessThan(5000); // no proxy start (that alone takes seconds)
      expect(e.status).toBe('capped');
      expect(e.error).toMatch(/SOL cap/);
      expect(e.signature).toBeUndefined();
      expect(e.steps).toEqual({});
      expect(existsSync(`${cfg.dataDir}/audit`)).toBe(false);
      const all = readEntries(file);
      expect(all).toHaveLength(2);
      expect(all[1]!.status).toBe('capped');
      expect(all[1]!.dryRun).toBe(true);
    } finally { cleanup(); }
  });
});
