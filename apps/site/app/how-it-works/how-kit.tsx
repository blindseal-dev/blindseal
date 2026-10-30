'use client';
import { usePageKit, decorate } from '../use-page-kit';
import disclosure from '../verify/disclosure-sample.json';
import { canonicalJson } from '../verify/disclosure';

// S02 · How it works — the mockup's page.js (design/mockups/mockups/S02/page.js), run once the kit
// has mounted the chrome (use-page-kit.ts). page.tsx renders the mockup's static markup; this fills
// every value page.js took from the fixtures, from the real data page.tsx computed (HowData), and
// drives the TOC from one place, as the kit's Whitepaper.tsx does:
//   1. scroll progress → the rail fill (transform scaleY, damped 100 ms linear)
//   2. scroll-spy      → the active link (IO rootMargin -20% 0px -70% 0px: the deepest section in
//                        the reader's band), plus two edges the kit leaves open: above section 01
//                        nothing is active, and at the very bottom the last section is
//   3. TOC links smooth-scroll (instant under reduced motion), update the hash and move focus to
//      the section title.
// Every hash goes through BS.ui.hash(value, { label }). Nothing here touches the server render:
// is-rising, measured widths and the figures happen only inside the effect.
export interface LayerResult { layer: string; ran: boolean; verdict: string; score?: number }
export interface HowData {
  att: { actionHash: string; nullifier: string; expirySlot: number; policyRoot: string; txSig: string | null; status: string };
  action: { targetProgram: string; sourceAuthority: string; instruction: string; recipient: string; mint: string; amount: string };
  programName: string | null;
  /** the action hash for the action as attested, and for the same action one lamport higher (server-computed) */
  hashes: { intact: string; altered: string };
  decision: { id: string; server: string; tool: string; layers: LayerResult[]; verdict: string; payloadHash: string; redactedHash: string; redactions: { kind: string; count: number }[] };
  rules: { L0: number; L1: number };
}

type Entry = { index: number; hash: string; prevHash: string; ts: string; verdict: string; decisionId: string; payloadHash: string };
const AUDIT_DOMAIN = 'blindseal.audit.v1';
const WINDOW: [number, number] = [194, 197];

/** Walk the disclosure's entries from the first one up to the head, recomputing every link
 *  (apps/site/app/verify/disclosure.ts, the chain part): each hash reproduces from its six-field
 *  core, each prevHash is the previous hash, and the last entry is the head. */
async function walkChain(): Promise<{ ok: boolean; checkedFrom: number; checkedTo: number; brokenAt?: number }> {
  const entries = disclosure.entries as Entry[];
  const head = disclosure.head as { index: number; hash: string };
  const enc = new TextEncoder();
  const sha = async (domain: string, text: string) => {
    const d = enc.encode(domain), t = enc.encode(text);
    const buf = new Uint8Array(d.length + t.length); buf.set(d); buf.set(t, d.length);
    return '0x' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (x) => x.toString(16).padStart(2, '0')).join('');
  };
  if (!entries.length) return { ok: true, checkedFrom: -1, checkedTo: -1 };
  const from = entries[0]!.index;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const core = { index: e.index, ts: e.ts, decisionId: e.decisionId, verdict: e.verdict, payloadHash: e.payloadHash, prevHash: e.prevHash };
    const bad = (await sha(AUDIT_DOMAIN, canonicalJson(core))) !== e.hash ||
      (i > 0 && (e.prevHash !== entries[i - 1]!.hash || e.index !== entries[i - 1]!.index + 1));
    if (bad) return { ok: false, checkedFrom: from, checkedTo: e.index - 1, brokenAt: e.index };
  }
  const last = entries[entries.length - 1]!;
  if (last.index === head.index && last.hash !== head.hash) return { ok: false, checkedFrom: from, checkedTo: last.index - 1, brokenAt: last.index };
  return { ok: true, checkedFrom: from, checkedTo: last.index };
}

export function HowKit({ data: D }: { data: HowData }) {
  usePageKit((BS) => {
    const M = BS.motion, ui = BS.ui, fmt = BS.fmt || ui.fmt;
    const reduced = () => !!M.reduced();
    const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null;
    const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
    const esc = (s: unknown) => (ui.esc ? ui.esc(s) : String(s)) as string;
    const hash = (v: string, label: string) => ui.hash(v, { label }) as string;
    const kvItem = (k: string, v: string, sub?: string) =>
      '<div class="kv__item"><span class="kv__k">' + esc(k) + '</span><span class="kv__v">' + v + '</span>' +
      (sub ? '<span class="hiw-kv__sub">' + sub + '</span>' : '') + '</div>';
    const ico = (n: string) => (BS.icon ? BS.icon(n) : '') as string;
    const cleanups: Array<() => void> = [];
    const on = (t: EventTarget, type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
      t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o));
    };

    /* ── masthead: the faint field + the stagger ─────────────────────────── */
    const mast = $('.hiw-mast'), body = $('.hiw'), space = $('.hiw-mast__space');
    if (space && BS.mountSpace && !space.hasAttribute('data-space-mounted')) {
      space.setAttribute('data-space-mounted', '');
      const sp = BS.mountSpace(space, { intensity: 'faint', fade: false });
      cleanups.push(() => { try { sp?.stop?.(); } catch { /* already gone */ } space.removeAttribute('data-space-mounted'); });
    }
    if (!reduced()) { mast?.classList.add('is-rising'); body?.classList.add('is-rising'); }

    const att = D.att, action = D.action, ex = D.decision;

    /* ── 01 · the route line ─────────────────────────────────────────────── */
    const port = $('[data-port]'); if (port) port.textContent = ':' + ((BS.PORTS && BS.PORTS.proxy) || 7777);
    /* no upstream list on the site (the proxy's /status is local-only): the route keeps "Tools" */

    /* ── 02 · rule counts + the example decision ─────────────────────────── */
    (['L0', 'L1'] as const).forEach((L) => {
      const n = D.rules[L], el = $('[data-count="' + L + '"]');
      if (el && n) el.textContent = n + (L === 'L0' ? ' decoders' : ' rules') + ' in the committed policy.';
    });
    const exTool = $('[data-ex-tool]'), exStrip = $('[data-ex-strip]'), exVerdict = $('[data-ex-verdict]'), exNote = $('[data-ex-note]');
    if (exTool) exTool.innerHTML = esc(ex.server) + '<span> · </span>' + esc(ex.tool);
    if (exStrip) exStrip.innerHTML = ui.layerStrip(ex.layers);
    if (exVerdict) exVerdict.innerHTML = ui.verdict(ex.verdict);
    const l2 = ex.layers[2], l3 = ex.layers[3];
    let note: string;
    if (l2 && l2.verdict === 'flag' && l3 && l3.ran && l3.verdict === 'pass' && l2.score != null && l3.score != null) {
      note = 'L2 flagged it at ' + l2.score.toFixed(2) + '. The judge read the redacted payload, cleared it at ' +
        l3.score.toFixed(2) + ', and the call went through. L0 and L1 found nothing.';
    } else if (l2 && !l2.ran && l3 && !l3.ran) {
      note = 'L0 decoded nothing and L1 matched none of the ' + D.rules.L1 + ' rules, so the call was clean and the model layers did not run. ' +
        'This is decision ' + ex.id + ', the one the attestation below proves.';
    } else {
      note = 'Each cell is one layer. The verdict is the worst of the rules and the model layer that ran last.';
    }
    if (exNote) exNote.textContent = note;

    /* ── 03 · redaction: the two hashes and the kinds ────────────────────── */
    const ph = $('[data-ph]'), rh = $('[data-rh]'), kinds = $('[data-kinds]');
    if (ph) ph.innerHTML = hash(ex.payloadHash, 'payloadHash');
    if (rh) rh.innerHTML = hash(ex.redactedHash, 'redactedHash');
    if (kinds) kinds.innerHTML = ex.redactions.map((r) => '<span class="chip neutral">' + esc(r.kind) + ' ×' + r.count + '</span>').join('');
    const arrow = $('.hiw-redact__arrow');
    if (arrow && !arrow.dataset.kitDraw) { arrow.dataset.kitDraw = '1'; const stop = M.mountDrawIn(arrow); cleanups.push(() => { try { stop?.(); } catch { /* noop */ } }); }

    /* ── 04 · the attestation in the figure ──────────────────────────────── */
    const attKv = $('[data-att-kv]');
    if (attKv) attKv.innerHTML =
      kvItem('Status', ui.status(att.status)) +
      kvItem('Action hash', hash(att.actionHash, 'Action hash')) +
      kvItem('Nullifier', hash(att.nullifier, 'Nullifier'), 'spent on consume') +
      kvItem('Expiry slot', '<span class="hiw-kv__mono">' + esc(fmt.slot(att.expirySlot)) + '</span>') +
      kvItem('Transaction', att.txSig ? hash(att.txSig, 'Transaction') : '<span class="hiw-kv__sub">not submitted</span>');

    /* ── 05 · what binds it: the five fields → the action hash ───────────── */
    let altered = false;
    const bindKv = $('[data-bind-kv]'), bindHash = $('[data-bind-hash]'), bindState = $('[data-bind-state]');
    const toggle = $<HTMLButtonElement>('[data-bind-toggle]'), bindBox = $('[data-bind]');
    function renderBind() {
      const a = { ...action };
      if (altered) a.amount = String(BigInt(action.amount) + 1n);
      const lamports = fmt.int ? fmt.int(Number(a.amount)) : a.amount;
      if (bindKv) bindKv.innerHTML =
        kvItem('Target program', hash(a.targetProgram, 'Target program'), esc(D.programName || a.instruction || '')) +
        kvItem('Recipient', hash(a.recipient, 'Recipient')) +
        kvItem('Amount', '<span data-amount>' + esc(fmt.amount(a.amount)) + ' SOL</span>', '<span data-amount>' + esc(lamports) + ' lamports</span>') +
        kvItem('Policy root', hash(att.policyRoot, 'Policy root')) +
        kvItem('Expiry slot', '<span class="hiw-kv__mono">' + esc(fmt.slot(att.expirySlot)) + '</span>');
      const h = altered ? D.hashes.altered : D.hashes.intact, ok = h === att.actionHash;
      if (bindHash) bindHash.innerHTML = hash(h, 'Action hash');
      if (bindState) bindState.innerHTML = ok
        ? '<span class="chip neutral">' + ico('check') + 'Matches the attestation</span>'
        : '<span class="chip flag">' + ico('circle-alert') + 'No match · worthless for this call</span>';
      if (toggle) {
        toggle.setAttribute('aria-pressed', altered ? 'true' : 'false');
        const s = toggle.querySelector('span'); if (s) s.textContent = altered ? 'Restore the amount' : 'Change the amount by one lamport';
      }
    }
    renderBind();
    if (toggle) on(toggle, 'click', () => {
      altered = !altered;
      if (reduced() || !bindBox) { renderBind(); return; }
      bindBox.classList.add('is-swapping');
      M.wait(140).then(() => { renderBind(); M.raf2(() => { bindBox.classList.remove('is-swapping'); }); });
    });

    /* ── 06 · the head + walk the chain ──────────────────────────────────── */
    const head = disclosure.head, entriesAll = disclosure.entries as Entry[];
    const hk = $('[data-head-kv]');
    if (hk) {
      hk.style.setProperty('--kv-cols', '3');
      hk.innerHTML =
        kvItem('Chain head', '<span class="hiw-kv__mono">#' + esc(fmt.int ? fmt.int(head.index) : head.index) + '</span>') +
        kvItem('Head hash', hash(head.hash, 'Head hash')) +
        kvItem('Window shown', '<span class="hiw-kv__mono">#' + WINDOW[0] + ' – #' + WINDOW[1] + '</span>');
    }
    const walkBtn = $<HTMLButtonElement>('[data-walk-btn]'), walkList = $('[data-walk]');
    if (walkBtn && walkList) on(walkBtn, 'click', () => {
      if (walkBtn.getAttribute('aria-busy') === 'true') return;
      const n = entriesAll.length;
      walkList.innerHTML = ui.checkItem({ title: 'Recompute ' + n + ' entries back from the head', state: 'running', end: '' });
      const li = walkList.firstElementChild;
      walkBtn.setAttribute('aria-busy', 'true');
      walkBtn.disabled = true;
      Promise.all([M.wait(900), walkChain()]).then(([, r]) => {
        if (r.ok) ui.check(li, 'pass', { end: '#' + r.checkedFrom + ' – #' + r.checkedTo + ' intact' });
        else ui.check(li, 'fail', { end: 'breaks at #' + r.brokenAt, reason: 'Entry #' + r.brokenAt + ' does not match the hash its successor recorded. #' + r.checkedFrom + ' – #' + r.checkedTo + ' are intact.' });
        walkBtn.removeAttribute('aria-busy');
        walkBtn.disabled = false;
        const s = walkBtn.querySelector('span'); if (s) s.textContent = 'Walk it again';
      });
    });

    /* ── the four figures (round 2: they loop under html.bs-site; no replay control) ─────── */
    const entries = entriesAll.slice(0, 10).map((e) => ({ index: e.index, hash: e.hash }));
    const FIGS: Array<[string, string, Record<string, unknown>]> = [
      ['#fig-architecture', 'architecture', {}],
      /* the layers figure paints the example decision's verdicts (page.js: the fixture's L2 flag) */
      ['#fig-layers', 'layers', { results: ex.layers.map((l) => ({ layer: l.layer, verdict: l.ran ? l.verdict : 'skip' })) }],
      ['#fig-lifecycle', 'lifecycle', { status: att.status }],
      ['#fig-chain', 'chain', entries.length ? { window: WINDOW, entries } : { window: WINDOW }],
    ];
    FIGS.forEach((f) => {
      const el = $(f[0]); if (!el) return;
      const host = BS.diagrams.render(f[1], el, f[2]) as HTMLElement | null;
      if (!host) return;
      const cap = host.querySelector(':scope > figcaption');
      if (cap) cap.setAttribute('data-n', host.getAttribute('data-fig-n') || '');
      /* the loop is the kit's (diagrams.js startLoop); stop it with the figure on route change */
      cleanups.push(() => { try { BS.diagrams.loopOf?.(host)?.stop?.(); } catch { /* already gone */ } });
    });
    decorate($('.hiw') || document);

    /* ── the TOC: progress fill + scroll-spy + navigation ────────────────── */
    const secs = $$('.hiw-sec');
    const links: Record<string, HTMLAnchorElement> = {};
    $$<HTMLAnchorElement>('[data-toc]').forEach((a) => { links[a.getAttribute('data-toc') || ''] = a; });
    const fill = $('.hiw-toc__fill'), topBtn = $<HTMLButtonElement>('[data-top]');
    const visible: Record<string, 1> = {};
    let ioActive = '', active: string | null = null, atBottom = false;

    function setActive(id: string) {
      if (id === active) return;
      active = id;
      Object.keys(links).forEach((k) => {
        const onIt = k === id;
        links[k]!.classList.toggle('is-active', onIt);
        if (onIt) links[k]!.setAttribute('aria-current', 'location'); else links[k]!.removeAttribute('aria-current');
      });
    }
    function resolve() {
      if (!secs.length) return;
      if (atBottom) return setActive(secs[secs.length - 1]!.id);
      /* above the first section's band: nothing is active (the masthead is not in the contents) */
      if (secs[0]!.getBoundingClientRect().top > window.innerHeight * 0.3) return setActive('');
      setActive(ioActive);
    }
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; });
      for (let i = secs.length - 1; i >= 0; i--) { if (visible[secs[i]!.id]) { ioActive = secs[i]!.id; break; } }
      resolve();
    }, { rootMargin: '-20% 0px -70% 0px' });
    secs.forEach((s) => io.observe(s));
    cleanups.push(() => io.disconnect());

    let pend = 0;
    function onScroll() {
      pend = 0;
      const se = document.scrollingElement || document.documentElement;
      const max = se.scrollHeight - window.innerHeight;
      const y = window.scrollY;
      const p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
      if (fill) fill.style.transform = 'scaleY(' + p.toFixed(4) + ')';
      atBottom = max > 0 && max - y < 2;
      if (topBtn) topBtn.disabled = y < 8;
      resolve();
    }
    const schedule = () => { if (!pend) pend = requestAnimationFrame(onScroll); };
    on(window, 'scroll', schedule, { passive: true });
    on(window, 'resize', schedule);
    cleanups.push(() => { if (pend) cancelAnimationFrame(pend); pend = 0; });
    onScroll();

    function go(id: string) {
      const sec = document.getElementById(id);
      if (!sec) return;
      sec.scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth', block: 'start' });
      try { history.replaceState(null, '', '#' + id); } catch { /* opaque origin */ }
      const h = sec.querySelector('h2');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
    Object.keys(links).forEach((id) => {
      on(links[id]!, 'click', (e) => {
        const me = e as MouseEvent;
        if (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1) return;
        e.preventDefault();
        go(id);
      });
    });
    if (topBtn) on(topBtn, 'click', () => {
      window.scrollTo({ top: 0, behavior: reduced() ? 'instant' : 'smooth' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* opaque origin */ }
      const t = $('#hiw-title'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); }
    });

    BS.page = { go, active: () => active, figures: FIGS.map((f) => f[0]) };
    cleanups.push(() => { if (BS.page && BS.page.go === go) delete BS.page; });
    return () => { cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch { /* noop */ } }); };
  });
  return null;
}
