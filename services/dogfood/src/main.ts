#!/usr/bin/env node
/// blindseal-dogfood — run one tick now, then one every intervalHours (default 6 h). A tick that is still
/// running (a CPU proof takes hours) is never overlapped: the timer skips and says so.
///
///   blindseal-dogfood [--config <file>] [--dry-run] [--once] [--data-dir <dir>] [--interval-hours <h>] [--wallet <file>]
///
/// Live mode refuses to start without the wallet keypair, a resource URL and (by warning) BLINDSEAL_RPC_URL.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { applyOverrides, ConfigError, configFromJson, livePreflightProblems, loadConfigFile, type CliOverrides, type DogfoodConfig } from './config.js';
import { logPath } from './log.js';
import { runTick } from './tick.js';

const HELP = `blindseal-dogfood — use Blindseal end to end on a timer (x402 purchase + gated SOL transfer through the proxy)

Usage
  blindseal-dogfood [flags]

Flags
  --config <file>        JSON config (default ./dogfood.config.json when present; see dogfood.config.example.json)
  --dry-run              no network side effects: mock merchant, fixture attestation, simulated submission
  --once                 run one tick and exit
  --data-dir <dir>       where the JSONL log and per-tick files go (default ~/.blindseal/dogfood)
  --interval-hours <h>   timer interval (default 6)
  --wallet <file>        keypair path (default ~/.blindseal/dogfood-wallet.json; must exist in live mode)
  --help, -h             this help

Log: <data-dir>/dogfood.jsonl, one line per tick. Nothing secret is ever printed or logged.
`;

interface Args extends CliOverrides { config?: string; once?: boolean; help?: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--once') a.once = true;
    else if (x === '--config') a.config = argv[++i];
    else if (x === '--data-dir') a.dataDir = argv[++i];
    else if (x === '--wallet') a.walletPath = argv[++i];
    else if (x === '--interval-hours') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--interval-hours must be a positive number');
      a.intervalHours = v;
    } else throw new Error(`unknown flag: ${x}`);
  }
  return a;
}

export function loadConfig(a: Args): DogfoodConfig {
  const file = a.config ?? (existsSync('dogfood.config.json') ? 'dogfood.config.json' : undefined);
  const base = file ? loadConfigFile(path.resolve(file)) : configFromJson({}); // expands ~ in the defaults
  return applyOverrides(base, a);
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try { a = parseArgs(argv); } catch (e) { process.stderr.write(`blindseal-dogfood: ${(e as Error).message}\n${HELP}`); return 2; }
  if (a.help) { process.stdout.write(HELP); return 0; }
  let cfg: DogfoodConfig;
  try { cfg = loadConfig(a); } catch (e) {
    process.stderr.write(`blindseal-dogfood: ${e instanceof ConfigError ? e.message : (e as Error).message}\n`);
    return 2;
  }
  const problems = livePreflightProblems(cfg);
  const hard = problems.filter((p) => !p.startsWith('BLINDSEAL_RPC_URL'));
  for (const p of problems) process.stderr.write(`blindseal-dogfood: ${hard.includes(p) ? 'error' : 'warning'}: ${p}\n`);
  if (hard.length) return 1;

  const log = (l: string) => process.stdout.write(`${new Date().toISOString()} ${l}\n`);
  log(`mode ${cfg.dryRun ? 'DRY RUN' : 'LIVE (mainnet)'}, interval ${cfg.intervalHours} h, log ${logPath(cfg.dataDir)}, caps ${cfg.maxSolPerDay} SOL / ${cfg.maxUsdcPerDay} USDC per day`);

  // Children of the step in flight, so a SIGTERM to the service does not orphan a prover.
  const killers = new Set<() => void>();
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    stopping = true;
    log(`${sig}: stopping${killers.size ? ` (${killers.size} child process${killers.size === 1 ? '' : 'es'})` : ''}`);
    for (const k of killers) { try { k(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(128 + (sig === 'SIGINT' ? 2 : 15)), 2000).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let running = false;
  const tick = async () => {
    if (running) { log('previous tick still running; skipping this one'); return; }
    running = true;
    try {
      await runTick(cfg, { log, track: (kill) => { killers.add(kill); } });
    } catch (e) {
      log(`tick crashed: ${(e as Error).message}`);
    } finally {
      killers.clear();
      running = false;
    }
  };

  await tick();
  if (a.once || stopping) return 0;
  const intervalMs = Math.round(cfg.intervalHours * 3600_000);
  log(`next tick in ${cfg.intervalHours} h`);
  await new Promise<void>(() => {
    const timer = setInterval(() => { void tick().then(() => { if (!stopping) log(`next tick in ${cfg.intervalHours} h`); }); }, intervalMs);
    process.on('SIGINT', () => clearInterval(timer));
    process.on('SIGTERM', () => clearInterval(timer));
  });
  return 0;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = new URL(import.meta.url).pathname;
  return path.resolve(entry) === self || path.resolve(entry).replace(/\.ts$/, '.js') === self.replace(/\.ts$/, '.js');
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { if (code !== 0) process.exit(code); }).catch((e) => {
    process.stderr.write(`blindseal-dogfood: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
