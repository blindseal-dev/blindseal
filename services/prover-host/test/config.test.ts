import { describe, expect, it } from 'vitest';
import { ConfigError, isPubkey, parseConfig } from '../src/config.js';
import { usdcAtomic } from '../src/billing/x402.js';

const PK = 'GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L';

describe('config', () => {
  it('fills defaults and reserves the vast and network sections', () => {
    const c = parseConfig({ dataDir: '/tmp/x', priceUsdc: '0.25', payTo: PK, vast: { gpu: 'RTX_4090', maxPriceUsdPerHour: 1.5 }, network: { enabled: false } });
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8402, backend: 'local', concurrency: 1, paymentNetwork: 'solana', facilitatorUrl: 'https://facilitator.payai.network', priceUsdc: '0.25', vast: { gpu: 'RTX_4090' }, network: { enabled: false } });
  });

  it('reports every problem at once, by field', () => {
    let err: ConfigError | undefined;
    try { parseConfig({ port: 70000, backend: 'cloud', concurrency: 0, priceUsdc: '0.1234567', network: 'solana', extra: 1 }); } catch (e) { err = e as ConfigError; }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.problems.map((p) => p.split(':')[0])).toEqual(['port', 'dataDir', 'backend', 'concurrency', 'priceUsdc', 'network', 'extra']);
    expect(err!.problems.find((p) => p.startsWith('network'))).toContain('paymentNetwork');
  });

  it('requires payTo when the price is not zero, and a real address', () => {
    expect(() => parseConfig({ dataDir: 'd', priceUsdc: '1' })).toThrow(/payTo: is required/);
    expect(() => parseConfig({ dataDir: 'd', priceUsdc: '1', payTo: 'not-an-address' })).toThrow(/payTo: must be a Solana address/);
    expect(parseConfig({ dataDir: 'd', priceUsdc: 0 }).payTo).toBeUndefined();
    expect(isPubkey(PK)).toBe(true);
    expect(isPubkey('11111111111111111111111111111111')).toBe(true);
    expect(isPubkey('z'.repeat(44))).toBe(false); // 33 bytes
    expect(isPubkey('1'.repeat(31))).toBe(false); // 31 bytes
    expect(isPubkey('not-an-address')).toBe(false);
  });

  it('converts a USDC price to atomic units', () => {
    expect(usdcAtomic('0.50')).toBe('500000');
    expect(usdcAtomic('1')).toBe('1000000');
    expect(usdcAtomic('0.000001')).toBe('1');
    expect(usdcAtomic(2.5)).toBe('2500000');
    expect(() => usdcAtomic('0.0000001')).toThrow();
  });
});
