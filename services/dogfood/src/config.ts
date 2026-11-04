/// Dogfood configuration: a JSON file (--config, default ./dogfood.config.json when it exists), then
/// command-line flags on top. Every amount is a plain number in its natural unit (SOL, USDC) except
/// lamports, which are integers. Secrets are never part of the config: the RPC URL comes from
/// BLINDSEAL_RPC_URL and the wallet is only ever read from the keypair file by the processes that sign.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';

export interface X402Config {
  /// The one paid resource a tick buys. Required in live mode; ignored in dry run (the mock server's URL is used).
  resourceUrl: string;
  /// Refuse any 402 that asks for more than this (USDC).
  maxPriceUsdc: number;
  /// When non-empty, refuse a 402 whose payTo is not one of these addresses.
  payToAllowlist: string[];
}

export interface DogfoodConfig {
  dryRun: boolean;
  intervalHours: number;
  dataDir: string;
  walletPath: string;
  /// Recipient of the gated SOL transfer (base58).
  recipient: string;
  transferLamports: number;
  /// Daily caps, rolling 24 h, counted from the JSONL log (see ledger.ts).
  maxSolPerDay: number;
  maxUsdcPerDay: number;
  /// What one gated transfer costs on top of the amount (fee + nullifier rent), counted against maxSolPerDay.
  txOverheadLamports: number;
  x402: X402Config;
  prover: { path?: string; cuda: 'auto' | 'never' | 'always' };
  proxy: { allowDegraded: boolean; tradeGuard: boolean; auditDir?: string };
  attest: { noExpiry: boolean };
}

/// The mainnet sample (docs/release-0.7.0-notes.md): dry run copies its attestation and reports its consume signature.
export const FIXTURE_RECIPIENT = '6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo';
export const FIXTURE_SOURCE_AUTHORITY = 'GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L';
export const FIXTURE_LAMPORTS = 1_000_000;
export const FIXTURE_CONSUME_SIGNATURE = '2HrABCZYnaHk66gmg9yi3mB27t487mpF6HgZMgbQJcxBhTm2L7nr1P2BbHPd46gHQWAvscAuJCTTGHtQz5mCFj26';

export const DEFAULT_CONFIG: DogfoodConfig = {
  dryRun: false,
  intervalHours: 6,
  dataDir: '~/.blindseal/dogfood',
  walletPath: '~/.blindseal/dogfood-wallet.json',
  recipient: FIXTURE_RECIPIENT,
  transferLamports: FIXTURE_LAMPORTS,
  maxSolPerDay: 0.01,
  maxUsdcPerDay: 1.0,
  txOverheadLamports: 1_100_000,
  x402: { resourceUrl: '', maxPriceUsdc: 0.1, payToAllowlist: [] },
  prover: { cuda: 'auto' },
  proxy: { allowDegraded: false, tradeGuard: true },
  attest: { noExpiry: false },
};

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function num(j: Json, key: string, dflt: number, opts: { int?: boolean; min?: number } = {}): number {
  const v = j[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`${key} must be a number`);
  if (opts.int && !Number.isSafeInteger(v)) throw new ConfigError(`${key} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`${key} must be >= ${opts.min}`);
  return v;
}
function str(j: Json, key: string, dflt: string): string {
  const v = j[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'string') throw new ConfigError(`${key} must be a string`);
  return v;
}
function bool(j: Json, key: string, dflt: boolean): boolean {
  const v = j[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') throw new ConfigError(`${key} must be true or false`);
  return v;
}

export function isPubkey(s: string): boolean {
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}

/// Merge a parsed config file over the defaults, validating types and ranges.
export function configFromJson(raw: unknown, base: DogfoodConfig = DEFAULT_CONFIG): DogfoodConfig {
  if (!isObj(raw)) throw new ConfigError('config must be a JSON object');
  const x = isObj(raw.x402) ? raw.x402 : {};
  const prover = isObj(raw.prover) ? raw.prover : {};
  const proxy = isObj(raw.proxy) ? raw.proxy : {};
  const attest = isObj(raw.attest) ? raw.attest : {};
  const cudaRaw = str(prover, 'cuda', base.prover.cuda);
  if (cudaRaw !== 'auto' && cudaRaw !== 'never' && cudaRaw !== 'always') throw new ConfigError('prover.cuda must be auto, never or always');
  const allow = x.payToAllowlist === undefined ? base.x402.payToAllowlist : x.payToAllowlist;
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) throw new ConfigError('x402.payToAllowlist must be an array of addresses');
  const cfg: DogfoodConfig = {
    dryRun: bool(raw, 'dryRun', base.dryRun),
    intervalHours: num(raw, 'intervalHours', base.intervalHours, { min: 0.01 }),
    dataDir: expandHome(str(raw, 'dataDir', base.dataDir)),
    walletPath: expandHome(str(raw, 'walletPath', base.walletPath)),
    recipient: str(raw, 'recipient', base.recipient),
    transferLamports: num(raw, 'transferLamports', base.transferLamports, { int: true, min: 1 }),
    maxSolPerDay: num(raw, 'maxSolPerDay', base.maxSolPerDay, { min: 0 }),
    maxUsdcPerDay: num(raw, 'maxUsdcPerDay', base.maxUsdcPerDay, { min: 0 }),
    txOverheadLamports: num(raw, 'txOverheadLamports', base.txOverheadLamports, { int: true, min: 0 }),
    x402: {
      resourceUrl: str(x, 'resourceUrl', base.x402.resourceUrl),
      maxPriceUsdc: num(x, 'maxPriceUsdc', base.x402.maxPriceUsdc, { min: 0 }),
      payToAllowlist: allow as string[],
    },
    prover: { cuda: cudaRaw, ...(typeof prover.path === 'string' ? { path: expandHome(prover.path) } : base.prover.path ? { path: base.prover.path } : {}) },
    proxy: {
      allowDegraded: bool(proxy, 'allowDegraded', base.proxy.allowDegraded),
      tradeGuard: bool(proxy, 'tradeGuard', base.proxy.tradeGuard),
      ...(typeof proxy.auditDir === 'string' ? { auditDir: expandHome(proxy.auditDir) } : base.proxy.auditDir ? { auditDir: base.proxy.auditDir } : {}),
    },
    attest: { noExpiry: bool(attest, 'noExpiry', base.attest.noExpiry) },
  };
  if (!isPubkey(cfg.recipient)) throw new ConfigError(`recipient is not a base58 public key: ${cfg.recipient}`);
  for (const a of cfg.x402.payToAllowlist) if (!isPubkey(a)) throw new ConfigError(`x402.payToAllowlist entry is not a public key: ${a}`);
  return cfg;
}

export function loadConfigFile(file: string): DogfoodConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`); }
  return configFromJson(raw);
}

export interface CliOverrides { dryRun?: boolean; dataDir?: string; intervalHours?: number; walletPath?: string }

export function applyOverrides(cfg: DogfoodConfig, o: CliOverrides): DogfoodConfig {
  return {
    ...cfg,
    dryRun: o.dryRun ?? cfg.dryRun,
    dataDir: o.dataDir ? expandHome(o.dataDir) : cfg.dataDir,
    intervalHours: o.intervalHours ?? cfg.intervalHours,
    walletPath: o.walletPath ? expandHome(o.walletPath) : cfg.walletPath,
  };
}

/// What live mode needs before the first tick; dry run needs none of it. Returns the problems, in plain words.
export function livePreflightProblems(cfg: DogfoodConfig): string[] {
  if (cfg.dryRun) return [];
  const out: string[] = [];
  if (!existsSync(cfg.walletPath)) {
    out.push(`wallet keypair not found at ${cfg.walletPath}. Live mode signs the x402 payment and the gated transfer with it. ` +
      'Create or copy the funded keypair there (solana-keygen new --outfile <path>), or run with --dry-run.');
  }
  if (!cfg.x402.resourceUrl) out.push('x402.resourceUrl is empty: name the paid resource a tick buys.');
  else if (!/^https?:\/\//.test(cfg.x402.resourceUrl)) out.push(`x402.resourceUrl is not an http(s) URL: ${cfg.x402.resourceUrl}`);
  if (!process.env.BLINDSEAL_RPC_URL) out.push('BLINDSEAL_RPC_URL is unset: the public mainnet RPC is rate-limited; set your own endpoint (never put it in the config file).');
  return out;
}

export const USDC_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const usdcToAtomic = (usdc: number): bigint => BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
