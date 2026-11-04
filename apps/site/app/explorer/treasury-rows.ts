// The Treasury tab's markup as plain HTML strings — ONE builder for the server render (treasury-view.tsx
// puts it in with dangerouslySetInnerHTML, so the tab reads without JS) and for the client's Retry repaint
// (same strings, so React never owns these children). Rows and totals come from @blindseal/chain-reads'
// TreasurySnapshot (docs/TREASURY-MEMO.md says how a row gets its kind). No clock, no locale beyond
// en-US, no window: a timestamp is the transaction's blockTime, formatted in UTC.
import type { TreasurySnapshot, TreasuryRow, TreasuryKind } from '@blindseal/chain-reads';
import { esc, fmtInt, hashHtml } from './rows';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => (n < 10 ? '0' : '') + n;
const shortB58 = (s: string) => (s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s);

/** base units → "1,234.50": grouped integer part, the fraction without trailing zeros but at least two digits */
export function fmtAmount(base: string, decimals: number): string {
  let s = String(base || '0').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  while (s.length <= decimals) s = '0' + s;
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, '');
  return fmtInt(Number(i)) + (decimals > 0 ? '.' + (f.length < 2 ? (f + '00').slice(0, 2) : f) : '');
}
/** "Nov 3, 2026 · 14:02 UTC"; a transaction without a blockTime shows its slot */
export function fmtWhen(blockTime: number | null, slot: number): string {
  if (blockTime == null) return 'slot ' + fmtInt(slot);
  const d = new Date(blockTime * 1000);
  return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ' · ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
}

/** Solana's own explorer for a transaction signature (a plain link; nothing is fetched until it is followed) */
export const txUrl = (sig: string) => 'https://explorer.solana.com/tx/' + encodeURIComponent(sig);

const KIND_LABEL: Record<TreasuryKind, string> = { proof: 'Proof bought', payout: 'Payout', buyback: 'Buyback', burn: 'Burn', other: 'Other' };
const KIND_CHIP: Record<TreasuryKind, string> = { proof: 'chip accent', payout: 'chip neutral', buyback: 'chip neutral', burn: 'chip outline', other: 'chip outline' };

export const TREASURY_ROW_CAP = 200;   // newest first; the foot says how many there are in all

export function treasuryRowHtml(r: TreasuryRow, i: number, usdcMint: string): string {
  const usdc = r.mint === usdcMint;
  const sign = r.direction === 'in' ? '+' : r.direction === 'out' ? '−' : '';
  const unit = r.direction === 'burn' ? 'burned' : usdc ? 'USDC' : shortB58(r.mint);
  const whoLabel = r.direction === 'burn' ? 'Mint' : r.direction === 'in' ? 'From' : 'To';
  return '<li class="ex-tx' + (r.internal ? ' is-internal' : '') + '" style="--i:' + i + '" data-kind="' + esc(r.kind) + '" data-direction="' + esc(r.direction) + '">' +
    '<span class="ex-tx__kind"><span class="' + KIND_CHIP[r.kind] + '">' + esc(KIND_LABEL[r.kind]) + '</span></span>' +
    '<span class="ex-tx__sig">' + hashHtml(r.signature, { label: 'Transaction' }) +
      '<a class="ex-tx__ext" href="' + esc(txUrl(r.signature)) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc('Open transaction ' + shortB58(r.signature) + ' in the Solana explorer') + '"><i data-lucide="external-link"></i></a></span>' +
    '<span class="ex-tx__when">' + esc(fmtWhen(r.blockTime, r.slot)) + '</span>' +
    '<span class="ex-tx__amt is-' + esc(r.direction) + '">' + sign + esc(fmtAmount(r.amount, r.decimals)) + ' <span class="ex-tx__unit">' + esc(unit) + '</span></span>' +
    '<span class="ex-tx__who"><span class="ex-tx__who-k">' + whoLabel + '</span>' + hashHtml(r.counterparty, { label: whoLabel }) +
      (r.internal ? '<span class="chip outline ex-tx__internal">internal (dogfood)</span>' : '') + '</span>' +
  '</li>';
}

export function treasuryRowsHtml(x: TreasurySnapshot): string {
  return x.rows.slice(0, TREASURY_ROW_CAP).map((r, i) => treasuryRowHtml(r, i, x.mint)).join('');
}

export function treasuryFootText(x: TreasurySnapshot): string {
  const internal = x.rows.filter((r) => r.internal).length;
  const shown = Math.min(x.rows.length, TREASURY_ROW_CAP);
  return (shown < x.rows.length ? 'newest ' + fmtInt(shown) + ' of ' : '') + fmtInt(x.rows.length) + ' rows · ' + fmtInt(internal) + ' internal (excluded from totals) · ' +
    fmtInt(x.source.tokenAccounts) + ' USDC account' + (x.source.tokenAccounts === 1 ? '' : 's') + ' · ' + fmtInt(x.source.signaturesScanned) + ' signatures read' + (x.source.truncated ? ' (capped: older rows are not listed)' : '');
}

export type TreasuryTotalsText = { proofs: string; collected: string; paidOut: string; buybacks: string; burns: string; burned: string };
export function treasuryTotalsText(x: TreasurySnapshot): TreasuryTotalsText {
  const t = x.totals;
  return {
    proofs: fmtInt(t.proofs), collected: fmtAmount(t.collected, 6), paidOut: fmtAmount(t.paidOut, 6), buybacks: fmtAmount(t.buybacks, 6), burns: fmtInt(t.burns),
    burned: t.burned.length ? t.burned.map((b) => fmtAmount(b.amount, b.decimals) + ' of ' + shortB58(b.mint)).join(' · ') : (t.burns ? 'no amounts on the burn rows' : 'none yet'),
  };
}

export type TreasuryView = 'unconfigured' | 'offline' | 'empty' | 'ready';
export const treasuryViewOf = (x: TreasurySnapshot): TreasuryView => !x.configured ? 'unconfigured' : !x.live ? 'offline' : x.rows.length === 0 ? 'empty' : 'ready';

const ERR_TITLE: Record<string, string> = { RPC_RATE_LIMITED: 'Mainnet RPC rate-limited', RPC_OFF: 'Mainnet reads are off', RPC_UNAVAILABLE: 'Mainnet RPC unavailable' };

function stat(k: string, v: string, d: string, lead = false) {
  return '<div class="stat ex-stat"><p class="stat__k">' + esc(k) + '</p><p class="stat__v ex-stat__v' + (lead ? ' ex-stat__v--lg' : '') + '">' + esc(v) + '</p><p class="stat__d"><span>' + esc(d) + '</span></p></div>';
}

/** The whole panel body for a snapshot: totals + the list when live, else the one block that stands in
 *  for them. `attempt` is the Retry counter the offline block shows (1 = the server's own read). */
export function treasuryPanelHtml(x: TreasurySnapshot, attempt = 1): string {
  const view = treasuryViewOf(x);
  if (view === 'unconfigured') {
    return '<section class="ex-alt ex-enter" id="ex-tr-alt" aria-live="polite"><div class="empty" role="status" data-treasury="unconfigured">' +
      '<span class="empty__icon"><i data-lucide="box"></i></span>' +
      '<p class="empty__title">Treasury not configured</p>' +
      '<p class="empty__body">This server has no treasury address (BLINDSEAL_TREASURY is unset), so there is nothing to read. When one is set, the treasury&#39;s USDC activity on mainnet is listed here.</p>' +
      '</div></section>';
  }
  if (view === 'offline') {
    const code = x.error?.code ?? 'RPC_UNAVAILABLE';
    return '<section class="ex-alt ex-enter" id="ex-tr-alt" aria-live="polite"><div class="ex-alt--error" data-treasury="offline">' +
      '<span class="ex-alt__icon" aria-hidden="true"><i data-lucide="circle-alert"></i></span>' +
      '<p class="ex-alt__title">' + esc(ERR_TITLE[code] ?? ERR_TITLE.RPC_UNAVAILABLE) + '</p>' +
      '<p class="ex-alt__body"><span data-msg>' + esc(x.error?.message || 'Solana RPC unreachable. Retry in a moment.') + '</span> No treasury rows to show; this page caches nothing.</p>' +
      '<p class="ex-alt__meta" data-meta>Attempt ' + attempt + ' · cluster mainnet · ' + esc(code) + '</p>' +
      '<span class="track ex-alt__track" aria-hidden="true"><span></span></span>' +
      '<div class="ex-alt__actions"><button type="button" class="btn secondary" id="ex-tr-retry"><i data-lucide="refresh-cw"></i><span>Retry</span></button></div>' +
      '</div></section>';
  }
  const t = treasuryTotalsText(x);
  let s = '<section class="ex-stats ex-tr-stats ex-enter" aria-label="Treasury totals">' +
    stat('Proofs bought', t.proofs, 'Paid in USDC, memo blindseal:proof', true) +
    stat('USDC collected', t.collected, 'From proofs bought') +
    stat('USDC paid out', t.paidOut, 'Payouts from the treasury') +
    stat('USDC on buybacks', t.buybacks, 'Spent buying back') +
    stat('Tokens burned', t.burns, t.burned) +
    '</section>';
  if (view === 'empty') {
    return s + '<section class="ex-alt ex-enter" id="ex-tr-alt" aria-live="polite"><div class="empty" role="status" data-treasury="empty">' +
      '<span class="empty__icon"><i data-lucide="box"></i></span>' +
      '<p class="empty__title">No treasury activity yet</p>' +
      '<p class="empty__body">The treasury&#39;s USDC accounts have no transfers yet. When a proof is bought, paid out, bought back or burned, the row shows here with its transaction.</p>' +
      '</div></section>';
  }
  return s + '<section class="site-panel ex-list ex-tr-list ex-enter" id="ex-tr-list" aria-labelledby="ex-tr-title">' +
    '<div class="ex-list__head"><p class="site-panel__n">Treasury · USDC</p><h2 class="site-panel__title" id="ex-tr-title">Transactions</h2>' +
    '<p class="ex-list__lede">Every USDC transfer in or out of the treasury, and every burn it signed, read from mainnet. The memo in the transaction gives a row its kind; rows from the internal wallet are labelled and count in no total.</p></div>' +
    '<div class="ex-cols ex-tx-cols" aria-hidden="true"><span>Kind</span><span>Transaction</span><span>When (UTC)</span><span class="ex-cols__num">Amount</span><span>Counterparty</span></div>' +
    '<ol class="ex-rows ex-tx-rows" id="ex-tr-rows" aria-label="Treasury transactions, newest first">' + treasuryRowsHtml(x) + '</ol>' +
    '<p class="ex-list__foot" id="ex-tr-foot">' + esc(treasuryFootText(x)) + '</p>' +
    '</section>';
}
