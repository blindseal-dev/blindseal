'use client';
// S05 · Explorer — the mockup's <main> children one-to-one (design/mockups/mockups/S05/index.html,
// "devnet" → "mainnet") plus its page.js, run through usePageKit once the kit has mounted. The JSX
// is the mockup's LOADING state and nothing in it depends on the clock, the viewport or the
// snapshot, so server HTML and hydration always agree; the kit then paints the props (odometers roll
// from 0, the chart is drawn into #ex-plot-svg, the lists are filled) exactly as the mockup paints
// its fixture after its fake load. Offline: the error panel; Retry re-reads /explorer/snapshot.
import { useRouter } from 'next/navigation';
import type { ExplorerSnapshot } from '@blindseal/chain-reads';
import { usePageKit, decorate, type BSAny } from '../use-page-kit';

const DAY = 86_400_000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (ymd: string) => { const p = ymd.split('-'); return MON[Number(p[1]) - 1] + ' ' + Number(p[2]); };

type Odo = { el: HTMLElement; set: (v: unknown) => void; value: () => unknown };
type LoadError = { code?: string; message?: string };
const PAD_L = 40, PAD_T = 12, PAD_B = 28, H = 248, GAP = 2, BAR_MAX = 24, R = 4;

export function ExplorerView({ snapshot }: { snapshot: ExplorerSnapshot }) {
  const router = useRouter();

  usePageKit((BS: BSAny) => {
    const M = BS.motion, ui = BS.ui, fmt = BS.fmt || ui.fmt;
    const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null;
    const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
    const esc = (s: unknown) => ui.esc(s) as string;
    const ico = (n: string) => (BS.icon ? (BS.icon(n) as string) : '');
    const reduced = () => !!M.reduced();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

    /* ── refs ────────────────────────────────────────────────────────────── */
    const mast = $('.ex-mast')!, page = $('#ex')!;
    const cluster = $('#ex-cluster')!, slotEl = $('#ex-slot')!, updated = $('#ex-updated')!;
    const plot = $('#ex-plot')!, plotSvg = $('#ex-plot-svg')!, plotSk = $('.ex-plot__sk')!, tip = $('#ex-tip')!, live = $('#ex-plot-live')!, table = $('#ex-table')!;
    const rangeEl = $('#ex-range')!, sumEl = $('#ex-sum')!, sumLabel = $('#ex-sum-label')!;
    const alt = $('#ex-alt')!;
    const rootsRows = $('#ex-roots-rows')!, rootsFoot = $('#ex-roots-foot')!, progRows = $('#ex-programs-rows')!, progFoot = $('#ex-programs-foot')!;

    /* ── masthead field + the entrance (S02 / S03 ladder) ────────────────── */
    const space = BS.mountSpace ? BS.mountSpace($('.ex-mast__space'), { intensity: 'faint', fade: false }) : null;
    $$('.ex-enter').forEach((el, i) => { el.style.setProperty('--e', String(Math.min(i, 6))); });
    if (!reduced()) {
      mast.classList.add('is-rising'); page.classList.add('is-rising');
      later(() => { page.classList.remove('is-rising'); }, M.scale(260 + 2 * 40 + 400 + 80));
    }

    /* ── odometers (tick mode) ───────────────────────────────────────────── */
    const intOrDash = (v: unknown) => (v == null ? '—' : typeof v === 'string' ? v : (fmt.int(v) as string));
    /* the kit's tick odometer only rolls cells that already exist, so a number growing from "0" would
       pop its new digits in. Seat a zero of the target's shape first (same frame, never painted),
       then every digit ticks. */
    const rollTo = (o: Odo, v: number | null) => {
      if (v != null && !reduced()) { const z = (fmt.int(v) as string).replace(/[0-9]/g, '0'); if (o.value() !== z) o.set(z); }
      o.set(v);
    };
    const odo: Record<string, Odo> = {};
    $$('[data-odo]').forEach((el) => { odo[el.getAttribute('data-odo')!] = M.odometer(el, 0, { mode: 'tick', format: intOrDash }); });
    const sumOdo: Odo = M.odometer(sumEl, 0, { mode: 'tick', format: intOrDash });
    let slotOdo: Odo | null = null;

    const SUBS: Record<string, string> = {
      total: 'All time on mainnet',
      day: 'Rolling window, UTC',
      roots: 'Hashes only; the rules stay local',
      programs: 'Programs that called the verifier',
    };
    const setSubs = (mode: 'loading' | 'ready') => {
      $$('[data-sub]').forEach((el) => {
        const k = el.getAttribute('data-sub')!;
        if (mode === 'loading') el.innerHTML = '<span class="skeleton" aria-hidden="true"></span><span class="sr-only">Loading</span>';
        else if (el.getAttribute('data-shown') !== '1' || el.querySelector('.skeleton')) el.innerHTML = '<span class="ex-fade">' + esc(SUBS[k]) + '</span>';
        el.setAttribute('data-shown', mode === 'loading' ? '0' : '1');
      });
    };

    /* ── the range switch ────────────────────────────────────────────────── */
    let range = 30;
    const seg = ui.seg(rangeEl, { value: '30', onChange: (v: string) => { range = Number(v); paintRange(true); } });
    const segDisabled = (on: boolean) => { $$<HTMLButtonElement>('.seg__item', rangeEl).forEach((b) => { b.disabled = on; }); };

    /* ── views ───────────────────────────────────────────────────────────── */
    let data: ExplorerSnapshot | null = null, attempt = 0;
    const setView = (v: 'loading' | 'ready' | 'offline' | 'empty') => {
      page.setAttribute('data-view', v);
      page.setAttribute('aria-busy', v === 'loading' ? 'true' : 'false');
      alt.hidden = !(v === 'offline' || v === 'empty');
      segDisabled(v !== 'ready');
    };

    const paintLoading = () => {
      setView('loading');
      cluster.setAttribute('data-state', 'loading');
      updated.textContent = 'Reading the verifier program…';
      setSubs('loading');
      plotSk.innerHTML = '<span class="skeleton"></span>';
      let sk = '';
      for (let i = 0; i < 5; i++) sk += '<li class="ex-row ex-row--sk" aria-hidden="true"><span class="skeleton ex-sk-n"></span><span class="skeleton ex-sk-id"></span><span class="skeleton ex-sk-v"></span><span class="skeleton ex-sk-p"></span></li>';
      rootsRows.innerHTML = sk; progRows.innerHTML = sk;
      rootsFoot.innerHTML = '<span class="skeleton ex-sk-id" aria-hidden="true" style="display:inline-block"></span>';
      progFoot.innerHTML = rootsFoot.innerHTML;
    };

    const paintCluster = (x: ExplorerSnapshot) => {
      cluster.setAttribute('data-state', 'live');
      if (!slotOdo) { slotEl.innerHTML = ''; slotOdo = M.odometer(slotEl, x.slot, { mode: 'tick', format: fmt.slot }); }
      else slotOdo.set(x.slot);
      updated.textContent = 'Updated ' + fmt.timeAgo(x.updatedAt) + ' · read-only';
    };

    /* last 24 h from the per-day series: today so far + the rest of yesterday's share of the window
       (the snapshot carries days, not hours — never a time finer than a UTC day) */
    const last24 = (perDay: ExplorerSnapshot['consumed']['perDay']) => {
      const n = perDay.length; if (!n) return 0;
      const now = Date.now(), day0 = Math.floor(now / DAY) * DAY, frac = Math.min(1, (now - day0) / DAY);
      return perDay[n - 1]!.count + Math.round((n > 1 ? perDay[n - 2]!.count : 0) * (1 - frac));
    };

    const onData = (x: ExplorerSnapshot) => {
      data = x;
      paintCluster(x);
      const total = x.consumed.total;
      if (!total) {   /* empty mainnet */
        setView('empty');
        setSubs('ready');
        odo.total!.set(0); odo.day!.set(0); odo.roots!.set(0); odo.programs!.set(0);
        alt.className = 'ex-alt';
        alt.innerHTML = ui.empty({
          icon: 'layers',
          title: 'No attestations consumed yet',
          body: 'When a program verifies an attestation on mainnet, the count shows here. Counts and hashes only: never the call, the agent or the operator.',
          actions: '<a class="btn secondary" href="/verify">' + ico('file-check') + 'Check an attestation</a>' +
                   '<a class="btn ghost" href="/how-it-works">How attestations work' + ico('arrow-right') + '</a>',
        });
        decorate(alt);
        enterAlt();
        return;
      }
      setView('ready');
      setSubs('ready');
      rollTo(odo.total!, total);
      rollTo(odo.day!, last24(x.consumed.perDay));
      rollTo(odo.roots!, x.policyRoots.length);
      rollTo(odo.programs!, x.consumerPrograms.length);
      paintRange(true);
      paintLists(x);
    };

    const onError = (e: LoadError | null | undefined) => {
      data = null;
      setView('offline');
      cluster.setAttribute('data-state', 'offline');
      if (slotOdo) { slotOdo = null; }
      slotEl.textContent = 'unavailable';
      updated.textContent = 'Last read failed · nothing cached';
      setSubs('ready');
      ['total', 'day', 'roots', 'programs'].forEach((k) => { odo[k]!.set(null); });
      const code = (e && e.code) || 'RPC_UNAVAILABLE';
      const msg = (e && e.message) || 'Solana RPC unreachable. Retry in a moment.';
      const first = !alt.querySelector('#ex-retry');
      if (first) {
        alt.className = 'ex-alt';
        alt.innerHTML =
          '<div class="ex-alt--error">' +
            '<span class="ex-alt__icon" aria-hidden="true">' + ico('circle-alert') + '</span>' +
            '<p class="ex-alt__title">Mainnet RPC unavailable</p>' +
            '<p class="ex-alt__body"><span data-msg></span> The explorer reads the chain directly; this page caches nothing.</p>' +
            '<p class="ex-alt__meta" data-meta></p>' +
            '<span class="track ex-alt__track" aria-hidden="true"><span></span></span>' +
            '<div class="ex-alt__actions"><button type="button" class="btn secondary" id="ex-retry">' + ico('refresh-cw') + '<span>Retry</span></button></div>' +
          '</div>';
        $('#ex-retry')!.addEventListener('click', retry);
        decorate(alt);
        enterAlt();
      }
      $('[data-msg]', alt)!.textContent = msg;
      $('[data-meta]', alt)!.textContent = 'Attempt ' + attempt + ' · cluster mainnet · ' + code;
      const b = $<HTMLButtonElement>('#ex-retry')!; b.removeAttribute('aria-busy'); b.disabled = false;
      $('.ex-alt__track', alt)!.classList.remove('is-on');
    };
    const enterAlt = () => { alt.classList.remove('is-in'); void alt.offsetWidth; if (!reduced()) alt.classList.add('is-in'); };

    /* the read: the server component delivered the first snapshot as props (attempt 1); Retry
       re-reads through the route handler, same shape */
    let disposed = false;
    const explorerLoad = (): Promise<ExplorerSnapshot> =>
      fetch('/explorer/snapshot', { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((r) => { if (!r.ok) throw { code: 'RPC_UNAVAILABLE', message: 'The snapshot endpoint answered ' + r.status + '. Retry in a moment.' }; return r.json() as Promise<ExplorerSnapshot>; })
        .then((x) => { if (!x.live) throw x.error || { code: 'RPC_UNAVAILABLE' }; return x; });
    const load = () => {
      attempt++;
      return explorerLoad().then((x) => { if (!disposed) onData(x); }, (e) => { if (!disposed) onError(e as LoadError); });
    };
    /* Retry keeps the frame: the panel stays, the button goes busy, a sweep runs, the load re-runs */
    function retry() {
      const b = $<HTMLButtonElement>('#ex-retry')!;
      b.setAttribute('aria-busy', 'true');
      $('.ex-alt__track', alt)!.classList.add('is-on');
      cluster.setAttribute('data-state', 'loading');
      slotEl.innerHTML = '<span class="skeleton ex-sk-slot" aria-hidden="true"></span><span class="sr-only">reading</span>';
      updated.textContent = 'Reading the verifier program…';
      load();
    }
    /* links painted into the alt block stay client-side navigations */
    const onAltClick = (e: Event) => {
      const a = (e.target as Element).closest?.('a[href^="/"]') as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented) return;
      e.preventDefault(); router.push(a.getAttribute('href')!);
    };
    alt.addEventListener('click', onAltClick);

    /* ══ the chart ═══════════════════════════════════════════════════════════ */
    type Geo = { list: ExplorerSnapshot['consumed']['perDay']; n: number; W: number; slot: number; bw: number; y: (v: number) => number; yBase: number };
    let geo: Geo | null = null, hot = -1, cascadeTimer: ReturnType<typeof setTimeout> | 0 = 0;

    const niceTop = (max: number) => {
      if (max <= 0) return 10;
      const half = max / 2, unit = max < 100 ? 5 : max < 400 ? 10 : max < 2000 ? 50 : 100;
      return Math.ceil(half / unit) * unit * 2;
    };
    const barPath = (x: number, yTop: number, w: number, yBase: number) => {
      const h = yBase - yTop; if (h <= 0) return '';
      const r = Math.min(R, w / 2, h);
      return 'M' + x + ' ' + yBase + 'V' + (yTop + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + yTop +
        'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (yTop + r) + 'V' + yBase + 'Z';
    };
    const xTicks = (n: number) => {
      const step = n <= 7 ? 1 : n <= 30 ? 7 : 15, out: number[] = [];
      for (let i = n - 1; i >= 0; i -= step) out.push(i);
      return out;
    };

    const days = () => (data ? data.consumed.perDay.slice(-range) : []);

    const draw = (animate: boolean) => {
      const list = days(), n = list.length;
      const W = Math.max(320, Math.round(plotSvg.clientWidth || plot.clientWidth));
      const plotH = H - PAD_T - PAD_B, slot = (W - PAD_L) / n, bw = Math.max(2, Math.min(BAR_MAX, slot - GAP));
      let max = 0; list.forEach((d) => { if (d.count > max) max = d.count; });
      const top = niceTop(max), yBase = PAD_T + plotH;
      const y = (v: number) => PAD_T + plotH * (1 - v / top);
      geo = { list, n, W, slot, bw, y, yBase };

      let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true" focusable="false">';
      s += '<g class="ex-axis">';
      [top, top / 2].forEach((v) => {
        const yy = Math.round(y(v)) + 0.5;
        s += '<line x1="' + PAD_L + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"></line>';
        s += '<text x="' + (PAD_L - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(fmt.int(v)) + '</text>';
      });
      s += '<line class="ex-axis__base" x1="' + PAD_L + '" x2="' + W + '" y1="' + (yBase + 0.5) + '" y2="' + (yBase + 0.5) + '"></line>';
      s += '<text x="' + (PAD_L - 10) + '" y="' + (yBase + 4) + '" text-anchor="end">0</text>';
      xTicks(n).forEach((i) => {
        let cx = PAD_L + slot * i + slot / 2, anchor = 'middle';
        if (cx - PAD_L < 20) { cx = PAD_L + slot * i + (slot - bw) / 2; anchor = 'start'; }
        if (W - cx < 20) { cx = PAD_L + slot * i + (slot + bw) / 2; anchor = 'end'; }
        s += '<text class="ex-axis__x" x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + esc(dayLabel(list[i]!.day)) + '</text>';
      });
      s += '</g>';

      const spread = n > 1 ? Math.min(30, 900 / (n - 1)) : 30;
      s += '<g class="ex-bars' + (animate && !reduced() ? ' is-cascading' : '') + '" style="--ex-step:' + spread.toFixed(2) + 'ms">';
      list.forEach((d, i) => {
        const x = PAD_L + slot * i + (slot - bw) / 2;
        const p = barPath(+x.toFixed(2), +y(d.count).toFixed(2), +bw.toFixed(2), yBase);
        if (p) s += '<path class="ex-bar" data-i="' + i + '" style="--i:' + i + '" d="' + p + '"></path>';
      });
      s += '</g></svg>';
      plotSvg.innerHTML = s;

      if (cascadeTimer) { clearTimeout(cascadeTimer); timers.delete(cascadeTimer); }
      if (animate && !reduced()) {
        const g = $('.ex-bars', plotSvg);
        cascadeTimer = later(() => { if (g) g.classList.remove('is-cascading'); }, M.scale((n - 1) * spread + 350 + 60));
      }
      hot = -1; hideTip();
    };

    const paintRange = (animate: boolean) => {
      if (!data) return;
      const list = days(); let sum = 0;
      list.forEach((d) => { sum += d.count; });
      sumOdo.set(sum);
      sumLabel.textContent = 'in the last ' + range + ' days';
      plotSvg.setAttribute('aria-label', 'Attestations consumed per day, last ' + range + ' days (UTC). Arrow keys read each day.');
      draw(animate);
      /* the table view: every value reachable without hovering */
      $('caption', table)!.textContent = 'Attestations consumed per day, last ' + range + ' days (UTC)';
      $('tbody', table)!.innerHTML = list.map((d) => '<tr><td>' + esc(d.day) + '</td><td>' + esc(fmt.int(d.count)) + '</td></tr>').join('');
    };

    /* ── the tooltip ─────────────────────────────────────────────────────── */
    const TODAY = new Date(Math.floor(Date.now() / DAY) * DAY).toISOString().slice(0, 10);
    const showTip = (i: number, instant: boolean) => {
      if (!geo || i < 0 || i >= geo.n) return;
      const d = geo.list[i]!;
      if (hot !== i) {
        const prev = $('.ex-bar.is-hot', plotSvg); if (prev) prev.classList.remove('is-hot');
        const bar = $('.ex-bar[data-i="' + i + '"]', plotSvg); if (bar) bar.classList.add('is-hot');
        hot = i;
      }
      $('.ex-tip__d', tip)!.textContent = dayLabel(d.day);
      $('.ex-tip__v', tip)!.textContent = fmt.int(d.count);
      $('.ex-tip__note', tip)!.textContent = d.day === TODAY ? 'so far' : '';
      let cx = PAD_L + geo.slot * i + geo.slot / 2; const w = tip.offsetWidth;
      cx = Math.max(w / 2, Math.min(geo.W - w / 2, cx));
      const yy = Math.min(geo.y(d.count), geo.yBase - 2);
      tip.style.left = cx.toFixed(1) + 'px';
      tip.style.top = yy.toFixed(1) + 'px';
      tip.classList.toggle('is-instant', !!instant || tip.classList.contains('is-on'));
      tip.classList.add('is-on');
    };
    function hideTip() {
      tip.classList.remove('is-instant');
      tip.classList.remove('is-on');
      const prev = $('.ex-bar.is-hot', plotSvg); if (prev) prev.classList.remove('is-hot');
      hot = -1;
    }
    const indexAt = (clientX: number) => {
      if (!geo) return -1;
      const r = plotSvg.getBoundingClientRect(), x = clientX - r.left - PAD_L;
      return Math.max(0, Math.min(geo.n - 1, Math.floor(x / geo.slot)));
    };
    const onMove = (e: PointerEvent) => {
      if (page.getAttribute('data-view') !== 'ready') return;
      const r = plotSvg.getBoundingClientRect(), yIn = e.clientY - r.top;
      if (yIn > H - PAD_B + 4 || e.clientX - r.left < PAD_L - 4) { hideTip(); return; }
      showTip(indexAt(e.clientX), false);
    };
    /* keyboard: arrows read each day; never animated */
    const onKey = (e: KeyboardEvent) => {
      if (!geo) return;
      let i = hot < 0 ? geo.n - 1 : hot;
      if (e.key === 'ArrowLeft') i = hot < 0 ? geo.n - 1 : Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = hot < 0 ? geo.n - 1 : Math.min(geo.n - 1, i + 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = geo.n - 1;
      else if (e.key === 'Escape') { hideTip(); return; }
      else return;
      e.preventDefault();
      showTip(i, true);
      const d = geo.list[i]!;
      live.textContent = dayLabel(d.day) + ': ' + fmt.int(d.count) + ' consumed' + (d.day === TODAY ? ' so far' : '');
    };
    plotSvg.addEventListener('pointermove', onMove);
    plotSvg.addEventListener('pointerleave', hideTip);
    plotSvg.addEventListener('keydown', onKey);
    plotSvg.addEventListener('blur', hideTip);

    let resizeT: ReturnType<typeof setTimeout> | 0 = 0;
    const onResize = () => {
      if (resizeT) { clearTimeout(resizeT); timers.delete(resizeT); }
      resizeT = later(() => { if (data && page.getAttribute('data-view') === 'ready') draw(false); }, 120);
    };
    window.addEventListener('resize', onResize);

    /* ══ the lists ══════════════════════════════════════════════════════════ */
    const pct = (c: number, t: number) => { if (!t) return '0%'; const p = (c / t) * 100; return (p < 1 ? '<1' : String(Math.round(p))) + '%'; };
    const rowHtml = (i: number, idHtml: string, count: number, total: number) => {
      const share = total ? count / total : 0;
      return '<li class="ex-row" style="--i:' + i + '">' +
        '<span class="ex-row__n">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="ex-row__id">' + idHtml + '</span>' +
        '<span class="ex-row__v">' + esc(fmt.int(count)) + '</span>' +
        '<span class="ex-row__share"><span class="ex-row__meter" aria-hidden="true"><i style="transform:scaleX(' + share.toFixed(4) + ')"></i></span>' +
        '<span class="ex-row__pct">' + esc(pct(count, total)) + '</span></span></li>';
    };
    const enterRows = (list: HTMLElement) => {
      list.classList.remove('is-entering'); void list.offsetWidth;
      if (!reduced()) {
        list.classList.add('is-entering');
        later(() => { list.classList.remove('is-entering'); }, M.scale(220 + 8 * 30 + 60));
      }
    };
    let listsPainted = false;
    const paintLists = (x: ExplorerSnapshot) => {
      const total = x.consumed.total;
      const roots = x.policyRoots.slice().sort((a, b) => b.count - a.count);
      rootsRows.innerHTML = roots.map((r, i) => rowHtml(i, ui.hash(r.root, { label: 'Policy root', lg: true }), r.count, total)).join('');
      const rs = roots.reduce((a, r) => a + r.count, 0);
      rootsFoot.textContent = roots.length + ' roots · sums to ' + fmt.int(rs) + (rs === total ? ', the total consumed' : '');

      const progs = x.consumerPrograms.slice().sort((a, b) => b.count - a.count);
      let unnamed = 0;
      progRows.innerHTML = progs.map((p, i) => {
        const name = p.name;
        if (!name) unnamed++;
        const nameHtml = name ? '<span class="ex-row__name">' + esc(name) + '</span>' : '<span class="ex-row__name is-none">No public name</span>';
        return rowHtml(i, ui.hash(p.programId, { label: 'Program id' }) + nameHtml, p.count, total);
      }).join('');
      const ps = progs.reduce((a, p) => a + p.count, 0);
      progFoot.textContent = progs.length + ' programs · ' + unnamed + ' without a public name · sums to ' + fmt.int(ps);
      decorate($('#ex-lists')!);
      /* first paint: the container's .reveal.cascade is the entrance (below the fold); later repaints rise in place */
      if (listsPainted) { enterRows(rootsRows); enterRows(progRows); }
      listsPainted = true;
    };

    /* ── go: the server already read once (attempt 1); paint what it delivered ── */
    paintLoading();
    attempt = 1;
    if (snapshot.live) onData(snapshot); else onError(snapshot.error);

    return () => {
      disposed = true;
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('resize', onResize);
      plotSvg.removeEventListener('pointermove', onMove);
      plotSvg.removeEventListener('pointerleave', hideTip);
      plotSvg.removeEventListener('keydown', onKey);
      plotSvg.removeEventListener('blur', hideTip);
      alt.removeEventListener('click', onAltClick);
      try { seg?.destroy?.(); } catch {}
      try { space?.stop?.(); } catch {}
    };
  });

  return (
    <>
      {/* ══ masthead: the S02 / S03 band (flat panel over the faint nebula, 300 high) ══ */}
      <header className="ex-mast" aria-labelledby="ex-title">
        <div className="ex-mast__space" aria-hidden="true"></div>
        <div className="ex-mast__copy">
          <p className="ex-mast__eyebrow">Explorer</p>
          <h1 className="ex-mast__title" id="ex-title">Attestations on mainnet.</h1>
          <p className="ex-mast__lede">What the verifier program has consumed. No content, no agents, no operators.</p>
        </div>
        <div className="ex-mast__end">
          <p className="ex-cluster" id="ex-cluster" data-state="loading" aria-live="polite">
            <span className="live-dot" aria-hidden="true"></span>
            <span className="ex-cluster__net">mainnet</span>
            <span className="ex-cluster__sep" aria-hidden="true"></span>
            <span className="ex-cluster__k">slot</span>
            <span className="ex-cluster__slot" id="ex-slot"><span className="skeleton ex-sk-slot" aria-hidden="true"></span><span className="sr-only">reading</span></span>
          </p>
          <p className="ex-cluster__sub" id="ex-updated">Reading the verifier program…</p>
        </div>
      </header>

      <div className="ex" id="ex" data-view="loading" aria-busy="true">

        {/* ══ the four totals ═══════════════════════════════════════════════ */}
        <section className="ex-stats ex-enter" aria-label="Totals on mainnet">
          <div className="stat ex-stat ex-stat--lead">
            <p className="stat__k">Attestations consumed</p>
            <p className="stat__v ex-stat__v ex-stat__v--lg" data-odo="total">0</p>
            <p className="stat__d" data-sub="total"><span>All time on mainnet</span></p>
          </div>
          <div className="stat ex-stat">
            <p className="stat__k">Last 24 h</p>
            <p className="stat__v ex-stat__v" data-odo="day">0</p>
            <p className="stat__d" data-sub="day"><span>Rolling window, UTC</span></p>
          </div>
          <div className="stat ex-stat">
            <p className="stat__k">Distinct policy roots</p>
            <p className="stat__v ex-stat__v" data-odo="roots">0</p>
            <p className="stat__d" data-sub="roots"><span>Hashes only; the rules stay local</span></p>
          </div>
          <div className="stat ex-stat">
            <p className="stat__k">Consumer programs</p>
            <p className="stat__v ex-stat__v" data-odo="programs">0</p>
            <p className="stat__d" data-sub="programs"><span>Programs that called the verifier</span></p>
          </div>
        </section>

        {/* ══ per day ═══════════════════════════════════════════════════════ */}
        <section className="site-panel ex-chart ex-enter" id="ex-chart" aria-labelledby="ex-chart-title">
          <div className="ex-chart__head">
            <div className="ex-chart__lead">
              <p className="site-panel__n">Per day · UTC</p>
              <h2 className="site-panel__title" id="ex-chart-title">Consumed per day</h2>
              <p className="ex-chart__sum"><span className="ex-chart__sum-v" id="ex-sum">0</span> <span id="ex-sum-label">in the last 30 days</span></p>
            </div>
            <div className="seg ex-range" id="ex-range" aria-label="Range">
              <button type="button" className="seg__item" data-value="7">7 d</button>
              <button type="button" className="seg__item is-active" data-value="30">30 d</button>
              <button type="button" className="seg__item" data-value="90">90 d</button>
            </div>
          </div>
          <div className="ex-plot" id="ex-plot">
            <div className="ex-plot__sk" aria-hidden="true"></div>
            <div className="ex-plot__svg" id="ex-plot-svg" tabIndex={0} role="group" aria-roledescription="bar chart"
                 aria-label="Attestations consumed per day. Arrow keys read each day." aria-describedby="ex-plot-help"></div>
            <div className="ex-tip" id="ex-tip" aria-hidden="true"><span className="ex-tip__d"></span><span className="ex-tip__sep">·</span><span className="ex-tip__v"></span><span className="ex-tip__note"></span></div>
            <p className="sr-only" id="ex-plot-help">Left and right arrows move one day; Home and End jump to the first and last day.</p>
            <p className="sr-only" id="ex-plot-live" aria-live="polite"></p>
            <table className="sr-only" id="ex-table"><caption></caption><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Consumed</th></tr></thead><tbody></tbody></table>
          </div>
        </section>

        {/* ══ offline / empty: one block in place of the chart and the lists ══ */}
        <section className="ex-alt" id="ex-alt" hidden aria-live="polite"></section>

        {/* ══ the two lists ═════════════════════════════════════════════════ */}
        <div className="ex-lists site-grid-2 reveal cascade" id="ex-lists">
          <section className="site-panel ex-list" id="ex-roots" aria-labelledby="ex-roots-title">
            <div className="ex-list__head">
              <p className="site-panel__n">Policy roots</p>
              <h2 className="site-panel__title" id="ex-roots-title">Committed policies in use</h2>
              <p className="ex-list__lede">A root is a Merkle hash of a policy. The rules behind it never leave the operator&apos;s machine.</p>
            </div>
            <div className="ex-cols" aria-hidden="true"><span>#</span><span>Root</span><span className="ex-cols__num">Consumed</span><span className="ex-cols__num">Share</span></div>
            <ol className="ex-rows" id="ex-roots-rows" aria-label="Policy roots by attestations consumed"></ol>
            <p className="ex-list__foot" id="ex-roots-foot"></p>
          </section>
          <section className="site-panel ex-list" id="ex-programs" aria-labelledby="ex-programs-title">
            <div className="ex-list__head">
              <p className="site-panel__n">Consumer programs</p>
              <h2 className="site-panel__title" id="ex-programs-title">Programs that called the verifier</h2>
              <p className="ex-list__lede">Program ids are public on chain. A name shows only where the program publishes one.</p>
            </div>
            <div className="ex-cols" aria-hidden="true"><span>#</span><span>Program id</span><span className="ex-cols__num">Consumed</span><span className="ex-cols__num">Share</span></div>
            <ol className="ex-rows" id="ex-programs-rows" aria-label="Consumer programs by attestations consumed"></ol>
            <p className="ex-list__foot" id="ex-programs-foot"></p>
          </section>
        </div>

        <p className="ex-foot">Nothing here can identify an agent or an operator. Policy roots are hashes; program ids are public.</p>
      </div>
    </>
  );
}
