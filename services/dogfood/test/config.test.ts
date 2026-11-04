import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { configFromJson, ConfigError, DEFAULT_CONFIG, livePreflightProblems, applyOverrides } from '../src/config.js';
import { parseArgs } from '../src/main.js';
import { tempDir } from './helpers.js';

describe('config', () => {
  it('defaults are the mainnet sample values and dry run is off', () => {
    const c = configFromJson({});
    expect(c.dryRun).toBe(false);
    expect(c.intervalHours).toBe(6);
    expect(c.recipient).toBe('6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo');
    expect(c.transferLamports).toBe(1_000_000);
    expect(c.walletPath.endsWith(path.join('.blindseal', 'dogfood-wallet.json'))).toBe(true);
  });

  it('rejects a bad recipient, a bad cuda setting and a non-integer lamports', () => {
    expect(() => configFromJson({ recipient: 'nope' })).toThrow(ConfigError);
    expect(() => configFromJson({ prover: { cuda: 'maybe' } })).toThrow(/prover.cuda/);
    expect(() => configFromJson({ transferLamports: 1.5 })).toThrow(/integer/);
  });

  it('dry run starts without a wallet, a resource URL or an RPC', () => {
    const { dir, cleanup } = tempDir('cfg');
    try {
      const c = applyOverrides(configFromJson({ walletPath: path.join(dir, 'missing.json') }), { dryRun: true });
      expect(livePreflightProblems(c)).toEqual([]);
    } finally { cleanup(); }
  });

  it('live mode names the missing wallet path and the empty resource URL in plain words', () => {
    const { dir, cleanup } = tempDir('cfg');
    try {
      const c = configFromJson({ walletPath: path.join(dir, 'missing.json') });
      const problems = livePreflightProblems(c);
      expect(problems.some((p) => p.includes(path.join(dir, 'missing.json')) && p.includes('--dry-run'))).toBe(true);
      expect(problems.some((p) => p.includes('x402.resourceUrl'))).toBe(true);
    } finally { cleanup(); }
  });

  it('--dry-run on the command line overrides the file', () => {
    const a = parseArgs(['--dry-run', '--once', '--data-dir', '/tmp/x', '--interval-hours', '0.5']);
    expect(a.dryRun).toBe(true);
    expect(a.once).toBe(true);
    const c = applyOverrides({ ...DEFAULT_CONFIG, dryRun: false }, a);
    expect(c.dryRun).toBe(true);
    expect(c.intervalHours).toBe(0.5);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});
