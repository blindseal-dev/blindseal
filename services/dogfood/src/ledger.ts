/// Daily caps. The ledger is the JSONL log itself: the spend of every entry in the last 24 h is summed
/// before a tick does anything that costs money. Dry-run entries and live entries are kept apart —
/// a dry-run tick is capped by earlier dry-run ticks (so the caps can be exercised without spending),
/// and a morning of dry runs does not eat the live budget.
import { LAMPORTS_PER_SOL, USDC_DECIMALS, solToLamports, usdcToAtomic, type DogfoodConfig } from './config.js';
import type { TickEntry } from './log.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface Spent { lamports: bigint; usdcAtomic: bigint }

export function spentInWindow(entries: readonly TickEntry[], opts: { now: Date; dryRun: boolean; windowMs?: number }): Spent {
  const since = opts.now.getTime() - (opts.windowMs ?? WINDOW_MS);
  let lamports = 0n;
  let usdcAtomic = 0n;
  for (const e of entries) {
    if (e.dryRun !== opts.dryRun) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < since || t > opts.now.getTime() + 60_000) continue;
    lamports += BigInt(Math.max(0, Math.trunc(e.spend.lamports)));
    usdcAtomic += BigInt(Math.max(0, Math.trunc(e.spend.usdcAtomic)));
  }
  return { lamports, usdcAtomic };
}

export interface CapCheck {
  ok: boolean;
  /// Why not, in plain words (empty when ok).
  reasons: string[];
  spent: Spent;
  /// How much USDC (atomic) this tick may still pay for the resource: the price cap, bounded by what is left today.
  usdcAllowanceAtomic: bigint;
}

/// Checked once, before the tick buys anything: the tick needs room for the purchase AND the transfer
/// (amount + overhead); otherwise it buys nothing and sends nothing.
export function checkCaps(cfg: DogfoodConfig, entries: readonly TickEntry[], now: Date): CapCheck {
  const spent = spentInWindow(entries, { now, dryRun: cfg.dryRun });
  const solCap = solToLamports(cfg.maxSolPerDay);
  const usdcCap = usdcToAtomic(cfg.maxUsdcPerDay);
  const need = BigInt(cfg.transferLamports) + BigInt(cfg.txOverheadLamports);
  const reasons: string[] = [];
  if (spent.lamports + need > solCap) {
    reasons.push(`SOL cap: ${fmtSol(spent.lamports)} spent in the last 24 h + ${fmtSol(need)} for this transfer (amount + overhead) exceeds maxSolPerDay ${cfg.maxSolPerDay}`);
  }
  const usdcLeft = usdcCap - spent.usdcAtomic;
  const priceCap = usdcToAtomic(cfg.x402.maxPriceUsdc);
  const usdcAllowanceAtomic = usdcLeft < priceCap ? (usdcLeft > 0n ? usdcLeft : 0n) : priceCap;
  if (usdcLeft <= 0n) {
    reasons.push(`USDC cap: ${fmtUsdc(spent.usdcAtomic)} spent in the last 24 h reaches maxUsdcPerDay ${cfg.maxUsdcPerDay}`);
  }
  return { ok: reasons.length === 0, reasons, spent, usdcAllowanceAtomic };
}

export const fmtSol = (lamports: bigint): string => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
export const fmtUsdc = (atomic: bigint): string => `${(Number(atomic) / 10 ** USDC_DECIMALS).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
