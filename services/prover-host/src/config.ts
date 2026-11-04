/// One JSON config file, path from `--config <file>` or $BLINDSEAL_PROVER_HOST_CONFIG. Every field is
/// checked on startup and all problems are reported at once, with the field name.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BackendName } from './backends/types.js';
import type { VastConfig } from './backends/vast.js';

export type PaymentNetwork = 'solana' | 'solana-devnet';

export interface HostConfig {
  /// Interface to bind. 127.0.0.1 by default: put your own TLS and rate limits in front.
  host: string;
  port: number;
  /// The URL clients reach the service at; named in the 402 as the paid resource. Default http://host:port.
  publicUrl?: string;
  /// Job records, payloads of unfinished jobs and finished attestations live here (created 0700).
  dataDir: string;
  backend: BackendName;
  proverPath?: string;
  /// Proofs run at once (default 1: a CPU proof uses every core it can get).
  concurrency: number;
  /// Price of one proof in USDC as a decimal string ('0.50'). '0' disables billing.
  priceUsdc: string;
  /// The Solana address that receives the USDC (required when priceUsdc > 0).
  payTo?: string;
  facilitatorUrl: string;
  /// The payment network. `solana` is mainnet; `solana-devnet` is for trying the flow with test USDC.
  paymentNetwork: PaymentNetwork;
  /// JSON-RPC endpoint for the default expiry (current slot + the window); $BLINDSEAL_RPC_URL overrides it.
  rpcUrl: string;
  /// Largest screened payload accepted (bytes of the tool-call JSON). Checked before screening and payment.
  maxPayloadBytes: number;
  /// Largest guest execution accepted, in SP1 cycles, measured by an executor pre-run (the prover with
  /// BLINDSEAL_EXECUTE=1, seconds) before payment. 0 disables the check. The mainnet sample is ~104.5 M.
  maxCycles: number;
  /// The rented-GPU backend.
  vast: Partial<VastConfig>;
}

export const DEFAULT_FACILITATOR_URL = 'https://facilitator.payai.network';
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const CONFIG_ENV = 'BLINDSEAL_PROVER_HOST_CONFIG';

export class ConfigError extends Error {
  constructor(public readonly problems: string[], source: string) {
    super(`invalid config (${source}):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/// True when `s` is base58 for exactly 32 bytes (a Solana public key).
export function isPubkey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BASE58.indexOf(c));
  let bytes = 0;
  for (let x = n; x > 0n; x >>= 8n) bytes++;
  let leading = 0;
  for (const c of s) { if (c !== '1') break; leading++; }
  return bytes + leading === 32;
}

/// USDC has six decimals; the price is kept as the decimal string the operator wrote.
export const PRICE_RE = /^\d+(\.\d{1,6})?$/;
export function priceIsZero(price: string): boolean { return /^0*(\.0*)?$/.test(price); }
export function billingEnabled(c: Pick<HostConfig, 'priceUsdc'>): boolean { return !priceIsZero(c.priceUsdc); }

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseConfig(raw: unknown, source = 'config'): HostConfig {
  const problems: string[] = [];
  const bad = (field: string, why: string) => { problems.push(`${field}: ${why}`); };
  if (!isObj(raw)) throw new ConfigError(['the config must be a JSON object'], source);

  const str = (k: string, dflt?: string): string | undefined => {
    const v = raw[k];
    if (v === undefined) return dflt;
    if (typeof v !== 'string' || v.length === 0) { bad(k, 'must be a non-empty string'); return dflt; }
    return v;
  };
  const int = (k: string, dflt: number, min: number, max: number): number => {
    const v = raw[k];
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) { bad(k, `must be an integer between ${min} and ${max}`); return dflt; }
    return v;
  };

  const host = str('host', '127.0.0.1')!;
  const port = int('port', 8402, 1, 65535);
  const publicUrl = str('publicUrl');
  if (publicUrl !== undefined && !/^https?:\/\//.test(publicUrl)) bad('publicUrl', 'must be an http(s) URL');
  const dataDir = str('dataDir');
  if (dataDir === undefined && raw.dataDir === undefined) bad('dataDir', 'is required');
  const backendRaw = str('backend', 'local')!;
  const backend: BackendName = (['local', 'vast'] as const).includes(backendRaw as BackendName) ? backendRaw as BackendName : 'local';
  if (backend !== backendRaw) bad('backend', `must be local or vast (got "${backendRaw}")`);
  const proverPath = str('proverPath');
  const concurrency = int('concurrency', 1, 1, 64);

  let priceUsdc = '0';
  if (raw.priceUsdc !== undefined) {
    const p = typeof raw.priceUsdc === 'number' ? String(raw.priceUsdc) : raw.priceUsdc;
    if (typeof p !== 'string' || !PRICE_RE.test(p)) bad('priceUsdc', 'must be a USDC amount with at most six decimals, e.g. "0.50" (0 disables billing)');
    else priceUsdc = p;
  }
  const payTo = str('payTo');
  if (payTo !== undefined && !isPubkey(payTo)) bad('payTo', 'must be a Solana address (base58, 32 bytes)');
  if (!priceIsZero(priceUsdc) && payTo === undefined) bad('payTo', 'is required when priceUsdc is not 0');
  const facilitatorUrl = str('facilitatorUrl', DEFAULT_FACILITATOR_URL)!.replace(/\/$/, '');
  if (!/^https?:\/\//.test(facilitatorUrl)) bad('facilitatorUrl', 'must be an http(s) URL');
  const pn = str('paymentNetwork', 'solana')!;
  const paymentNetwork: PaymentNetwork = pn === 'solana' || pn === 'solana-devnet' ? pn : 'solana';
  if (paymentNetwork !== pn) bad('paymentNetwork', `must be "solana" or "solana-devnet" (got "${pn}")`);
  const rpcUrl = str('rpcUrl', DEFAULT_RPC_URL)!;

  const maxPayloadBytes = int('maxPayloadBytes', 64 * 1024, 256, 1 << 20);
  const maxCycles = int('maxCycles', 300_000_000, 0, 10_000_000_000);
  let vast: Partial<VastConfig> = {};
  if (raw.vast !== undefined) {
    if (!isObj(raw.vast)) bad('vast', 'must be an object');
    else {
      const v = raw.vast;
      for (const k of ['apiKeyFile', 'gpu', 'image'] as const) if (v[k] !== undefined && typeof v[k] !== 'string') bad(`vast.${k}`, 'must be a string');
      for (const k of ['maxPriceUsdPerHour', 'maxInstanceAgeMinutes'] as const) if (v[k] !== undefined && (typeof v[k] !== 'number' || !(v[k] as number > 0))) bad(`vast.${k}`, 'must be a positive number');
      vast = v as Partial<VastConfig>;
    }
  }
  const known = new Set(['host', 'port', 'publicUrl', 'dataDir', 'backend', 'proverPath', 'concurrency', 'priceUsdc', 'payTo', 'facilitatorUrl', 'paymentNetwork', 'rpcUrl', 'maxPayloadBytes', 'maxCycles', 'vast']);
  for (const k of Object.keys(raw)) if (!known.has(k)) bad(k, 'is not a config field');

  if (problems.length) throw new ConfigError(problems, source);
  return {
    host, port, publicUrl, dataDir: path.resolve(dataDir!), backend, proverPath, concurrency,
    priceUsdc, payTo, facilitatorUrl, paymentNetwork, rpcUrl, maxPayloadBytes, maxCycles, vast,
  };
}

/// The config file named by `--config <file>` or $BLINDSEAL_PROVER_HOST_CONFIG.
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): HostConfig {
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--config') file = argv[i + 1];
  file ??= env[CONFIG_ENV];
  if (!file) throw new ConfigError([`no config: pass --config <file> or set ${CONFIG_ENV}`], 'startup');
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new ConfigError([`cannot read ${file}: ${(e as Error).message}`], file); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ConfigError([`not JSON: ${(e as Error).message}`], file); }
  return parseConfig(raw, file);
}
