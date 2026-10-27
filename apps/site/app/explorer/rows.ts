// The explorer's list rows, footers and per-day table as plain HTML strings — ONE builder for the server
// render (explorer-view.tsx puts them in with dangerouslySetInnerHTML, so the lists and the table read
// without JS) and for the page.js port's repaints (same strings, so React never owns these children and
// the effect's innerHTML can never fight it). The hash buttons are BS.ui.hash's markup, byte for byte
// (button.hash[data-hash][data-label], 0x… → 6+4, base58 → 4+4); the kit's document-level .hash delegation
// adds the copy and the full-value tooltip once it mounts. No clock, no locale beyond en-US, no window.
import type { ExplorerSnapshot } from '@blindseal/chain-reads';
import { splitConsumers } from '@blindseal/chain-reads/consumers';   // browser-safe entry (no node: imports)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]!);
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtInt = (n: number) => nf0.format(Math.round(Number(n) || 0));
const shortHash = (h: string) => (h.length > 12 ? h.slice(0, 6) + '…' + h.slice(-4) : h);
const shortB58 = (s: string) => (s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s);

/** BS.ui.hash(value, { label, lg }) */
export function hashHtml(value: string, o: { label?: string; lg?: boolean } = {}) {
  const full = String(value ?? '');
  const shown = /^0x/i.test(full) ? shortHash(full) : shortB58(full);
  return '<button type="button" class="hash' + (o.lg ? ' lg' : '') + '" data-hash="' + esc(full) + '"' +
    (o.label ? ' data-label="' + esc(o.label) + '"' : '') +
    ' aria-label="' + esc((o.label ? o.label + ' ' : '') + full + '. Copy') + '"><span class="hash__v">' + esc(shown) + '</span></button>';
}

const pct = (c: number, t: number) => { if (!t) return '0%'; const p = (c / t) * 100; return (p < 1 ? '<1' : String(Math.round(p))) + '%'; };
function rowHtml(i: number, idHtml: string, count: number, total: number) {
  const share = total ? count / total : 0;
  return '<li class="ex-row" style="--i:' + i + '">' +
    '<span class="ex-row__n">' + String(i + 1).padStart(2, '0') + '</span>' +
    '<span class="ex-row__id">' + idHtml + '</span>' +
    '<span class="ex-row__v">' + esc(fmtInt(count)) + '</span>' +
    '<span class="ex-row__share"><span class="ex-row__meter" aria-hidden="true"><i style="transform:scaleX(' + share.toFixed(4) + ')"></i></span>' +
    '<span class="ex-row__pct">' + esc(pct(count, total)) + '</span></span></li>';
}

export type ListsHtml = { roots: string; rootsFoot: string; programs: string; programsFoot: string; direct: string; programCount: number; directCount: number };

/** The two ranked lists. Direct submissions (consumer_program = Pubkey::default(), no gated program) are
 *  not a consumer program: they are left out of the list and its count and reported on their own line. */
export function listsHtml(x: ExplorerSnapshot): ListsHtml {
  const total = x.consumed.total;
  const roots = x.policyRoots.slice().sort((a, b) => b.count - a.count);
  const rs = roots.reduce((a, r) => a + r.count, 0);
  const { programs, direct } = splitConsumers(x.consumerPrograms);
  const progs = programs.slice().sort((a, b) => b.count - a.count);
  let unnamed = 0;
  const programsRows = progs.map((p, i) => {
    if (!p.name) unnamed++;
    const nameHtml = p.name ? '<span class="ex-row__name">' + esc(p.name) + '</span>' : '<span class="ex-row__name is-none">No public name</span>';
    return rowHtml(i, hashHtml(p.programId, { label: 'Program id' }) + nameHtml, p.count, total);
  }).join('');
  const ps = progs.reduce((a, p) => a + p.count, 0);
  return {
    roots: roots.map((r, i) => rowHtml(i, hashHtml(r.root, { label: 'Policy root', lg: true }), r.count, total)).join(''),
    rootsFoot: esc(roots.length + ' roots · sums to ' + fmtInt(rs) + (rs === total ? ', the total consumed' : '')),
    programs: programsRows,
    programsFoot: esc(progs.length + ' programs · ' + unnamed + ' without a public name · sums to ' + fmtInt(ps)),
    direct: direct ? esc(fmtInt(direct) + ' direct submission' + (direct === 1 ? '' : 's') + ' (no gated program)') : '',
    programCount: progs.length,
    directCount: direct,
  };
}

export const tableCaption = (range: number) => esc('Attestations consumed per day, last ' + range + ' days (UTC)');
export const tableRowsHtml = (list: ExplorerSnapshot['consumed']['perDay']) =>
  list.map((d) => '<tr><td>' + esc(d.day) + '</td><td>' + esc(fmtInt(d.count)) + '</td></tr>').join('');
