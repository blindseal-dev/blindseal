/// Dry run, end to end, through the REAL proxy: the x402 purchase against the in-process merchant, the
/// transfer request, the fixture attestation, the simulated submission and the JSONL line. The second
/// case serves an injected resource body and expects the proxy to block the reply and the tick to log it.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_CONSUME_SIGNATURE, FIXTURE_SOURCE_AUTHORITY } from '../src/config.js';
import { logPath, readEntries } from '../src/log.js';
import { FIXTURE_ATTESTATION, fixturesDir } from '../src/paths.js';
import { runTick } from '../src/tick.js';
import { dryRunConfig, tempDir } from './helpers.js';

describe('dry-run tick through the proxy', () => {
  it('buys the mock resource, asks for the transfer, copies the fixture attestation and logs a simulated signature', async () => {
    const { dir, cleanup } = tempDir('e2e');
    const lines: string[] = [];
    try {
      const cfg = dryRunConfig(dir);
      const e = await runTick(cfg, { log: (l) => lines.push(l) });
      expect(e.error, lines.join('\n')).toBeUndefined();
      expect(e.status).toBe('ok');
      expect(e.dryRun).toBe(true);
      expect(e.simulated).toBe(true);
      expect(e.signature).toBe(FIXTURE_CONSUME_SIGNATURE);
      expect(e.wallet).toBe(FIXTURE_SOURCE_AUTHORITY);
      // the purchase
      expect(e.x402?.status).toBe('paid');
      expect(e.x402?.priceAtomic).toBe('10000');
      expect((e.x402?.receipt as { success: boolean }).success).toBe(true);
      expect(e.spend).toEqual({ lamports: 1_000_000 + 1_100_000, usdcAtomic: 10_000 });
      // the attestation is the fixture, byte for byte
      expect(e.attestation?.nullifier).toBe('0xfb1e49f45e15f791c851ba596b939cefa4b4b47f0da2778e557c1b75df2b0aa7');
      expect(readFileSync(e.attestation!.file, 'utf8')).toBe(readFileSync(path.join(fixturesDir(), FIXTURE_ATTESTATION), 'utf8'));
      const call = JSON.parse(readFileSync(path.join(path.dirname(e.attestation!.file), 'toolcall.json'), 'utf8'));
      expect(call.toolName).toBe('transfer_sol');
      expect(call.args.to).toBe(cfg.recipient);
      expect(call.args.lamports).toBe(1_000_000);
      // every step ran and the log has the line
      expect(Object.keys(e.steps).sort()).toEqual(['attest', 'buy', 'submit', 'transfer']);
      const logged = readEntries(logPath(cfg.dataDir));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.signature).toBe(FIXTURE_CONSUME_SIGNATURE);
      expect(logged[0]!.dryRun).toBe(true);
      // the proxy kept its state under dataDir, not ~/.blindseal
      expect(existsSync(path.join(cfg.dataDir, 'audit'))).toBe(true);
      // and nothing secret is in the line
      expect(JSON.stringify(logged[0])).not.toMatch(/BLINDSEAL_RPC_URL|secretKey/);
    } finally { cleanup(); }
  });

  it('an injected resource body is blocked by the proxy and the tick is logged as blocked, with no transfer', async () => {
    const { dir, cleanup } = tempDir('e2e-inj');
    const lines: string[] = [];
    try {
      const cfg = dryRunConfig(dir);
      const e = await runTick(cfg, { log: (l) => lines.push(l), mock: { inject: true } });
      expect(e.status, lines.join('\n')).toBe('blocked');
      expect(e.blocked?.tool).toBe('buy_resource');
      expect(e.blocked?.direction).toBe('response');
      expect(e.blocked?.notice).toMatch(/\[BLINDSEAL_BLOCKED\]/);
      expect(e.signature).toBeUndefined();
      expect(e.attestation).toBeUndefined();
      expect(e.steps.transfer).toBeUndefined();
      expect(e.spend.lamports).toBe(0);
      expect(e.proxyNotices?.some((l) => /malicious|suspicious/.test(l))).toBe(true);
      const logged = readEntries(logPath(cfg.dataDir));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.status).toBe('blocked');
    } finally { cleanup(); }
  });
});
