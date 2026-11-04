/// One tick, end to end:
///   0. caps  — sum the last 24 h of the log; stop here if the purchase or the transfer would break a cap
///   1. proxy — start `blindseal` in front of this service's MCP server
///   2. buy   — tools/call buy_resource through the proxy (x402 purchase; the body comes back screened)
///   3. ask   — tools/call transfer_sol through the proxy (screened; nothing moves yet)
///   4. attest— prove that exact call (CUDA prover if present, else CPU)
///   5. submit— the gated transfer through transfer-gate (consumes the nullifier)
///   6. log   — one JSONL line with timestamps, signature, receipt, spend, dryRun
/// A refusal by the proxy at 2 or 3 ends the tick as `blocked` and is logged like everything else. Dry
/// run changes only what has side effects: the merchant and the RPC are the in-process mock, the wallet is
/// ephemeral, attest copies the fixture, submit is simulated. The proxy screening is the real thing.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_SOURCE_AUTHORITY, usdcToAtomic, type DogfoodConfig } from './config.js';
import { checkCaps } from './ledger.js';
import { appendEntry, logPath, readEntries, type StepRecord, type TickEntry, type X402Record } from './log.js';
import { startMockX402Server, type MockX402Options, type MockX402Server } from './mock/x402-server.js';
import { chooseProver } from './prover.js';
import { blockedBy, ProxySession, resultText } from './proxy.js';
import { attestStep, submitStep } from './steps.js';
import { walletPublicKey } from './wallet.js';

export interface TickDeps {
  now?: () => Date;
  log?: (line: string) => void;
  /// Dry run only: options for the in-process merchant (tests use `inject`).
  mock?: MockX402Options;
  /// Receives a way to kill the child processes of the step in flight (signal handling in main).
  track?: (kill: () => void) => void;
}

const MAX_NOTICES = 20;

export async function runTick(cfg: DogfoodConfig, deps: TickDeps = {}): Promise<TickEntry> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((l: string) => process.stdout.write(l + '\n'));
  const tickId = `${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const entry: TickEntry = { ts: now().toISOString(), tick: tickId, dryRun: cfg.dryRun, status: 'failed', wallet: '', steps: {}, spend: { lamports: 0, usdcAtomic: 0 } };
  const file = logPath(cfg.dataDir);
  const notices: string[] = [];
  const finish = (status: TickEntry['status']): TickEntry => {
    entry.status = status;
    entry.finishedAt = now().toISOString();
    if (notices.length) entry.proxyNotices = notices;
    appendEntry(file, entry);
    log(`tick ${tickId}: ${status}${entry.error ? ` — ${entry.error}` : ''}${entry.signature ? ` — signature ${entry.signature}${entry.simulated ? ' (simulated)' : ''}` : ''}`);
    return entry;
  };
  const step = async <T>(name: keyof TickEntry['steps'], fn: () => Promise<T>): Promise<T> => {
    const rec: StepRecord = { startedAt: now().toISOString(), finishedAt: '', ok: false };
    entry.steps[name] = rec;
    try {
      const v = await fn();
      rec.ok = true;
      return v;
    } finally {
      rec.finishedAt = now().toISOString();
    }
  };

  // 0. caps
  const caps = checkCaps(cfg, readEntries(file), now());
  if (!caps.ok) {
    entry.error = caps.reasons.join('; ');
    return finish('capped');
  }

  // wallet (public key only here)
  try {
    entry.wallet = cfg.dryRun ? FIXTURE_SOURCE_AUTHORITY : walletPublicKey(cfg.walletPath);
  } catch (e) {
    entry.error = (e as Error).message;
    return finish('failed');
  }

  let mock: MockX402Server | undefined;
  let proxy: ProxySession | undefined;
  try {
    if (cfg.dryRun) mock = await startMockX402Server(deps.mock ?? {});
    const resourceUrl = cfg.dryRun ? mock!.resourceUrl : cfg.x402.resourceUrl;

    // Environment for the proxy and, inherited, the MCP server. Live mode passes BLINDSEAL_RPC_URL through
    // from our own environment; dry run points the x402 client at the mock RPC and keeps the proxy's
    // state (audit chain, manifest cache, scan history) under dataDir so nothing touches ~/.blindseal.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BLINDSEAL_MODE: 'block',
      DOGFOOD_RESOURCE_URL: resourceUrl,
      DOGFOOD_X402_NETWORK: 'solana',
      DOGFOOD_MAX_PRICE_ATOMIC: caps.usdcAllowanceAtomic.toString(),
      DOGFOOD_PAYTO_ALLOWLIST: cfg.x402.payToAllowlist.join(','),
    };
    if (cfg.proxy.tradeGuard) {
      env.BLINDSEAL_TRADE_GUARD = '1';
      env.BLINDSEAL_TRADE_ALLOWLIST = cfg.recipient;
    }
    if (cfg.dryRun) {
      env.DOGFOOD_WALLET_EPHEMERAL = '1';
      delete env.DOGFOOD_WALLET_PATH;
      env.DOGFOOD_X402_RPC_URL = mock!.rpcUrl;
      env.BLINDSEAL_AUDIT_DIR = cfg.proxy.auditDir ?? path.join(cfg.dataDir, 'audit');
      env.BLINDSEAL_MANIFEST_CACHE_DIR = path.join(cfg.dataDir, 'manifest-cache');
      env.BLINDSEAL_PERSIST = '0';
    } else {
      env.DOGFOOD_WALLET_PATH = cfg.walletPath;
      delete env.DOGFOOD_WALLET_EPHEMERAL;
      if (cfg.proxy.auditDir) env.BLINDSEAL_AUDIT_DIR = cfg.proxy.auditDir;
    }
    mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });

    // 1. proxy
    proxy = ProxySession.start({
      env,
      allowDegraded: cfg.proxy.allowDegraded,
      onStderr: (line) => {
        if (/blindseal: (malicious|suspicious|blocked|dropped|capability-|MANIFEST DRIFT|DEGRADED|refusing)/.test(line) && notices.length < MAX_NOTICES) notices.push(line.slice(0, 300));
      },
    });
    deps.track?.(() => { void proxy?.close(0); });
    log(`tick ${tickId}: proxy starting (${cfg.dryRun ? 'dry run' : 'live'})`);
    const init = await proxy.initialize();
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error).slice(0, 300)}`);
    const tools = await proxy.request('tools/list', {}, 60_000);
    const names = ((tools.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
    if (!names.includes('buy_resource') || !names.includes('transfer_sol')) throw new Error(`MCP server lists ${names.join(', ') || 'no tools'}`);

    // 2. buy
    const bought = await step('buy', async () => {
      const reply = await proxy!.callTool('buy_resource', { url: resourceUrl }, 120_000);
      const blocked = blockedBy(reply, 'buy_resource');
      if (blocked) return { blocked };
      if (reply.error) throw new Error(`buy_resource: ${reply.error.message ?? 'error'}`);
      const r = resultText(reply);
      const j = r.json as { error?: string; status?: 'paid' | 'free'; priceAtomic?: string; asset?: string; payTo?: string; network?: string; receipt?: unknown } | undefined;
      if (r.isError || !j || j.error) throw new Error(`buy_resource: ${j?.error ?? (r.text.slice(0, 300) || 'tool error')}`);
      const x: X402Record = { resource: resourceUrl, status: j.status ?? 'paid', priceAtomic: j.priceAtomic ?? '0', asset: j.asset, payTo: j.payTo, network: j.network, receipt: j.receipt };
      return { x402: x };
    });
    if ('blocked' in bought && bought.blocked) {
      entry.blocked = bought.blocked;
      entry.error = `proxy blocked buy_resource (${bought.blocked.direction})`;
      return finish('blocked');
    }
    entry.x402 = (bought as { x402: X402Record }).x402;
    entry.spend.usdcAtomic = Number(BigInt(entry.x402.priceAtomic));
    if (BigInt(entry.x402.priceAtomic) > usdcToAtomic(cfg.x402.maxPriceUsdc)) throw new Error('paid more than x402.maxPriceUsdc'); // the client caps this; belt and braces
    log(`tick ${tickId}: bought ${resourceUrl} (${entry.x402.status}, ${entry.x402.priceAtomic} atomic USDC)`);

    // 3. ask for the transfer (screened; the server only echoes the canonical call)
    const callArgs = { to: cfg.recipient, lamports: cfg.transferLamports, from: entry.wallet, memo: `blindseal dogfood tick ${tickId}` };
    const asked = await step('transfer', async () => {
      const reply = await proxy!.callTool('transfer_sol', callArgs, 60_000);
      const blocked = blockedBy(reply, 'transfer_sol');
      if (blocked) return { blocked };
      if (reply.error) throw new Error(`transfer_sol: ${reply.error.message ?? 'error'}`);
      const r = resultText(reply);
      const j = r.json as { error?: string; status?: string; args?: Record<string, unknown> } | undefined;
      if (r.isError || !j || j.error || j.status !== 'gated') throw new Error(`transfer_sol: ${j?.error ?? (r.text.slice(0, 300) || 'tool error')}`);
      return { ok: true as const };
    });
    if ('blocked' in asked && asked.blocked) {
      entry.blocked = asked.blocked;
      entry.error = `proxy blocked transfer_sol (${asked.blocked.direction})`;
      return finish('blocked');
    }
    // The proxy's part is done: the server may go before the prover runs for hours.
    await proxy.close();
    proxy = undefined;

    // 4. attest
    const tickDir = path.join(cfg.dataDir, 'ticks', tickId);
    const prover = cfg.dryRun ? { kind: 'cpu' as const, note: 'dry run: no prover' } : await chooseProver({ explicit: cfg.prover.path, cuda: cfg.prover.cuda });
    log(`tick ${tickId}: attest (${prover.note})`);
    entry.attestation = await step('attest', () => attestStep({
      dryRun: cfg.dryRun, tickDir, call: { toolName: 'transfer_sol', args: callArgs },
      proverPath: prover.path, proverNote: prover.note, auditDir: cfg.proxy.auditDir, noExpiry: cfg.attest.noExpiry,
      env: process.env, onLine: (l) => log(`  attest: ${l}`), track: deps.track,
    }));

    // 5. submit
    const sent = await step('submit', () => submitStep({
      dryRun: cfg.dryRun, attestationFile: entry.attestation!.file, walletPath: cfg.walletPath,
      env: process.env, onLine: (l) => log(`  submit: ${l}`), track: deps.track,
    }));
    entry.signature = sent.signature;
    if (sent.simulated) entry.simulated = true;
    entry.spend.lamports = cfg.transferLamports + cfg.txOverheadLamports;
    return finish('ok');
  } catch (e) {
    entry.error = (e as Error).message.slice(0, 1500);
    return finish('failed');
  } finally {
    if (proxy) await proxy.close();
    if (mock) await mock.close();
  }
}
