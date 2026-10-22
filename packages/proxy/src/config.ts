import type { CapabilityConfig, CapabilityMode, TradePolicyConfig } from './capability/index.js';
import type { ManifestConfig, ManifestMode } from './manifest/index.js';
import type { TelemetryConfig } from './telemetry/index.js';
import type { AuditConfig } from './audit/index.js';
import { loadScanStoreConfig, type ScanStoreConfig } from './persistence/index.js';

export type BlindsealMode = 'block' | 'warn' | 'log';

export interface BlindsealConfig {
  mode: BlindsealMode;
  capability: CapabilityConfig;
  tradePolicy: TradePolicyConfig;
  manifest: ManifestConfig;
  telemetry: TelemetryConfig;
  audit: AuditConfig;
  persistence: ScanStoreConfig;
}

export function loadConfig(): BlindsealConfig {
  const raw = process.env.BLINDSEAL_MODE?.toLowerCase();
  const mode: BlindsealMode = raw === 'warn' || raw === 'log' ? raw : 'block';
  return {
    mode,
    capability: loadCapabilityConfig(),
    tradePolicy: loadTradePolicyConfig(),
    manifest: loadManifestConfig(),
    telemetry: loadTelemetryConfig(),
    audit: loadAuditConfig(),
    persistence: loadScanStoreConfig(),
  };
}

function loadAuditConfig(): AuditConfig {
  const filepath = process.env.BLINDSEAL_AUDIT_LOG;
  return { enabled: !!filepath, filepath };
}

function loadTelemetryConfig(): TelemetryConfig {
  // Default-on once a collector URL is configured. Opt out with BLINDSEAL_TELEMETRY in
  // {0, false, off, no}. See packages/proxy/PRIVACY.md.
  const flag = process.env.BLINDSEAL_TELEMETRY?.toLowerCase();
  const explicitlyOff =
    flag === '0' || flag === 'false' || flag === 'off' || flag === 'no';
  const explicitlyOn = flag === '1' || flag === 'true' || flag === 'on';
  const url = process.env.BLINDSEAL_TELEMETRY_URL;
  const enabled = !explicitlyOff && !!url;
  const secret = process.env.BLINDSEAL_TELEMETRY_SECRET;
  const batchSize = positiveInt(process.env.BLINDSEAL_TELEMETRY_BATCH, 100);
  const flushIntervalMs = positiveInt(process.env.BLINDSEAL_TELEMETRY_FLUSH_MS, 5000);
  return {
    enabled,
    url,
    secret,
    batchSize,
    flushIntervalMs,
    bannerOnStart: enabled && !explicitlyOn, // implicit-on path
  };
}

function loadManifestConfig(): ManifestConfig {
  const raw = process.env.BLINDSEAL_MANIFEST_CHECK?.toLowerCase();
  let mode: ManifestMode;
  if (raw === 'off' || raw === '0' || raw === 'false') mode = 'off';
  else if (raw === 'strict') mode = 'strict';
  else mode = 'on';
  const cacheDir = process.env.BLINDSEAL_MANIFEST_CACHE_DIR;
  return { mode, cacheDir };
}

function loadCapabilityConfig(): CapabilityConfig {
  const flag = process.env.BLINDSEAL_CAPABILITY?.toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'on';
  const modeRaw = process.env.BLINDSEAL_CAPABILITY_MODE?.toLowerCase();
  const mode: CapabilityMode = modeRaw === 'warn' ? 'warn' : 'block';

  const extraPatterns: RegExp[] = [];
  const rawPatterns = process.env.BLINDSEAL_SENSITIVE_TOOL_PATTERNS ?? '';
  for (const piece of rawPatterns.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    try {
      extraPatterns.push(new RegExp(trimmed, 'i'));
    } catch {
      process.stderr.write(`blindseal: invalid BLINDSEAL_SENSITIVE_TOOL_PATTERNS entry '${trimmed}', skipping\n`);
    }
  }

  const minOverlap = positiveInt(process.env.BLINDSEAL_TAINT_MIN_OVERLAP, 32);
  const windowSize = positiveInt(process.env.BLINDSEAL_TAINT_WINDOW_SIZE, 10);

  return { enabled, mode, extraPatterns, minOverlap, windowSize };
}

function compilePatterns(raw: string | undefined, defaults: RegExp[]): RegExp[] {
  if (!raw) return defaults;
  const out: RegExp[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, 'i'));
    } catch {
      process.stderr.write(`blindseal: invalid trade-policy pattern '${trimmed}', skipping\n`);
    }
  }
  return out.length > 0 ? out : defaults;
}

function csvList(raw: string | undefined, defaults: string[]): string[] {
  if (raw === undefined) return defaults;
  const out = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : defaults;
}

function loadTradePolicyConfig(): TradePolicyConfig {
  const flag = process.env.BLINDSEAL_TRADE_GUARD?.toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'on';
  const modeRaw = process.env.BLINDSEAL_TRADE_GUARD_MODE?.toLowerCase();
  const mode: CapabilityMode = modeRaw === 'warn' ? 'warn' : 'block';

  const recipientAllowlist = new Set(
    (process.env.BLINDSEAL_TRADE_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  // How to treat an unknown (non-allowlisted, non-tainted) payee. Default 'block' preserves
  // existing behavior; 'warn' stops over-blocking legitimate first-time payees.
  const allowlistMode: CapabilityMode =
    process.env.BLINDSEAL_TRADE_ALLOWLIST_MODE?.toLowerCase() === 'warn' ? 'warn' : 'block';

  const swapPatterns = compilePatterns(process.env.BLINDSEAL_TRADE_SWAP_TOOLS, [
    /swap/i,
    /trade/i,
    /transfer/i,
    /^send(_|$)/i,
    /execute_?swap/i,
  ]);
  const approvePatterns = compilePatterns(process.env.BLINDSEAL_TRADE_APPROVE_TOOLS, [
    /approve/i,
    /allowance/i,
    /permit/i,
  ]);
  const recipientKeys = csvList(process.env.BLINDSEAL_TRADE_RECIPIENT_KEYS, [
    'recipient',
    'to',
    'spender',
    'destination',
    'dest',
    'receiver',
  ]);
  const amountKeys = csvList(process.env.BLINDSEAL_TRADE_AMOUNT_KEYS, [
    'amount',
    'amountIn',
    'value',
    'allowance',
    'approvalAmount',
  ]);
  const tokenKeys = csvList(process.env.BLINDSEAL_TRADE_TOKEN_KEYS, [
    'symbol',
    'token',
    'tokenOut',
    'asset',
    'ticker',
  ]);
  // Tool-name patterns whose responses are trusted provenance. Default empty = every source
  // untrusted (a recipient from any tool-sourced lineage hard-blocks on taint).
  const trustedTools = compilePatterns(process.env.BLINDSEAL_TRADE_TRUSTED_TOOLS, []);

  const bigintEnv = (raw: string | undefined, def: bigint | null): bigint | null => {
    if (!raw || !/^\d+$/.test(raw.trim())) return def;
    try {
      return BigInt(raw.trim());
    } catch {
      return def;
    }
  };

  const maxApproval = bigintEnv(process.env.BLINDSEAL_TRADE_MAX_APPROVAL, 2n ** 200n) ?? 2n ** 200n;
  const maxTradeValue = bigintEnv(process.env.BLINDSEAL_TRADE_MAX_VALUE, null);
  const maxValuePerWindow = bigintEnv(process.env.BLINDSEAL_TRADE_MAX_VALUE_PER_WINDOW, null);
  const maxValuePerToken = bigintEnv(process.env.BLINDSEAL_TRADE_MAX_VALUE_PER_TOKEN, null);

  const rawPerWindow = process.env.BLINDSEAL_TRADE_MAX_PER_WINDOW;
  const maxPerWindow =
    rawPerWindow && /^\d+$/.test(rawPerWindow.trim()) ? Number.parseInt(rawPerWindow.trim(), 10) : null;

  const rawBreaker = process.env.BLINDSEAL_TRADE_BREAKER_THRESHOLD;
  const breakerThreshold =
    rawBreaker && /^\d+$/.test(rawBreaker.trim()) ? Number.parseInt(rawBreaker.trim(), 10) : null;

  const rawElevated = process.env.BLINDSEAL_TRADE_ELEVATED_THRESHOLD;
  const elevatedThreshold =
    rawElevated && /^\d+$/.test(rawElevated.trim()) ? Number.parseInt(rawElevated.trim(), 10) : null;
  const rawFactor = process.env.BLINDSEAL_TRADE_ELEVATED_FACTOR_PCT;
  const elevatedFactorPct =
    rawFactor && /^\d+$/.test(rawFactor.trim()) ? Math.min(100, Number.parseInt(rawFactor.trim(), 10)) : 25;

  const marketHours = parseMarketHours(process.env.BLINDSEAL_TRADE_MARKET_HOURS);
  const windowMs = positiveInt(process.env.BLINDSEAL_TRADE_WINDOW_MS, 60_000);

  return {
    enabled,
    mode,
    recipientAllowlist,
    allowlistMode,
    swapPatterns,
    approvePatterns,
    recipientKeys,
    amountKeys,
    tokenKeys,
    trustedTools,
    maxApproval,
    maxTradeValue,
    maxPerWindow,
    maxValuePerWindow,
    maxValuePerToken,
    elevatedThreshold,
    elevatedFactorPct,
    breakerThreshold,
    marketHours,
    windowMs,
  };
}

/// Parse "HH:MM-HH:MM" (UTC) into minutes-of-day. Returns null on anything malformed,
/// which leaves the market always open.
function parseMarketHours(raw: string | undefined): { startMin: number; endMin: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return null;
  return { startMin, endMin };
}

function positiveInt(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
