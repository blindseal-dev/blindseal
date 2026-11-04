'use client';
import { usePageKit, decorate } from '../use-page-kit';
import disclosure from '../verify/disclosure-sample.json';
import { canonicalJson } from '../verify/disclosure';
import './figures.css';

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
/* the figure GIFs already fetched into the HTTP cache in this page's lifetime (one warm-up per file) */
const warmed = new Set<string>();

/** The description the kit's render gives each figure's svg (diagrams.js: the aria text of architecture,
 *  layers, lifecycle and chain, built from the same options), used as the GIF's alt. */
function figLabel(name: string, o: Record<string, unknown>): string {
  if (name === 'architecture') {
    return 'Architecture. The agent calls its tools through the proxy on the same machine; the proxy screens every call ' +
      'with four layers (L0 decode, L1 patterns, L2 similarity, L3 judge), redacting secrets and PII before L2. The proof covers L0 and L1 (pending mainnet: the 0.8.0 verifier key is not yet allowed on chain). ' +
      'Every decision is written to a hash-chained audit log. The prover makes a zero-knowledge attestation; ' +
      'only the proof and its public inputs cross to the public side, where the Solana verifier checks it in one instruction.';
  }
  if (name === 'layers') {
    const paint: Record<string, string> = {};
    ((o.results as { layer: string; verdict: string }[] | undefined) || []).forEach((r) => {
      if (r && ['pass', 'block', 'flag', 'skip'].includes(r.verdict)) paint[r.layer] = r.verdict;
    });
    return 'Four screening layers. L0 decode and L1 patterns see the raw payload and are deterministic; both run inside the proof (pending mainnet: the 0.8.0 verifier key is not yet allowed on chain). ' +
      'Secrets and PII are redacted before L2 similarity and L3 judge, which see the redacted payload and are model-based, so they are attested.' +
      Object.keys(paint).map((k) => ' ' + k + ': ' + paint[k] + '.').join('');
  }
  if (name === 'lifecycle') {
    return 'Attestation lifecycle: decision, requested, generating, generated, submitted, consumed. ' +
      'Valid until its expiry slot; consuming it spends the nullifier, so it is single-use. Current status: ' + String(o.status || 'consumed') + '.';
  }
  /* chain: the entries (or ten from #1) and the disclosed window; no break is ever passed here */
  const given = (o.entries as { index: number }[] | undefined) || [];
  const idx = given.length ? given.slice(0, 10).map((e) => e.index) : Array.from({ length: 10 }, (_, i) => i + 1);
  const first = idx[0]!, last = idx[idx.length - 1]!, w = o.window as [number, number] | undefined;
  let win = w && w.length === 2 ? [Math.max(first, Math.min(w[0], w[1])), Math.min(last, Math.max(w[0], w[1]))] : null;
  if (win && win[0]! > win[1]!) win = null;
  return 'Audit chain of ' + idx.length + ' entries, #' + first + ' to #' + last + ', each linked to the hash of the one before.' +
    (win ? ' Disclosed range #' + win[0] + ' to #' + win[1] + ', content-free.' : '');
}

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

    /* ── the four figures ─────────────────────────────────────────────────────────────────
       Below 720 px (the kit's NARROW_Q) the kit draws its vertical figures (round 2: they loop under
       html.bs-site; no replay control). From 720 px up each figure is an animated GIF on the canvas
       colour with the same draw → hold → fade cycle baked in: its box is reserved from the file's size,
       the file is fetched into the HTTP cache one viewport ahead (a plain fetch: a detached Image could
       start the animation early), and src is set when the figure crosses the kit's draw-in line, so it
       plays from its first frame where the draw would have started. Reduced motion shows the drawn
       frame as a still and never requests the GIF. Crossing 720 px swaps the two. */
    const entries = entriesAll.slice(0, 10).map((e) => ({ index: e.index, hash: e.hash }));
    const FIGS: Array<[string, string, Record<string, unknown>]> = [
      ['#fig-architecture', 'architecture', {}],
      /* the layers figure paints the example decision's verdicts (page.js: the fixture's L2 flag) */
      ['#fig-layers', 'layers', { results: ex.layers.map((l) => ({ layer: l.layer, verdict: l.ran ? l.verdict : 'skip' })) }],
      ['#fig-lifecycle', 'lifecycle', { status: att.status }],
      ['#fig-chain', 'chain', entries.length ? { window: WINDOW, entries } : { window: WINDOW }],
    ];
    /* each GIF's pixel size, and the caption the kit renders for that figure (diagrams.js), word for word */
    const GIFS: Record<string, { w: number; h: number; caption: string }> = {
      architecture: { w: 960, h: 455, caption: 'Left of the rule stays on the machine. The verifier sees a proof and five public inputs, never the call.' },
      layers: { w: 476, h: 246, caption: 'L0 and L1 are deterministic and both run inside the proof, pending mainnet. L2 and L3 are model-based, run locally (TEE mode planned), and are attested.' },
      lifecycle: { w: 960, h: 198, caption: 'One attestation, one action, one use. Consuming it spends the nullifier; after the expiry slot it is worthless.' },
      chain: { w: 960, h: 147, caption: 'Each entry commits to the hash of the one before it. A disclosure proves a range without its content.' },
    };
    type FigHost = HTMLElement & { __dg?: { stop?: () => void } };
    type Fig = { el: FigHost; name: string; opts: Record<string, unknown>; mode: '' | 'kit' | 'gif' | 'still'; stop: () => void };
    const narrowMq = window.matchMedia('(max-width: 719.98px)');
    const want = () => (narrowMq.matches ? 'kit' : reduced() ? 'still' : 'gif');

    function kitFig(f: Fig) {
      const host = BS.diagrams.render(f.name, f.el, f.opts) as HTMLElement | null;
      if (!host) return;
      const cap = host.querySelector(':scope > figcaption');
      if (cap) cap.setAttribute('data-n', host.getAttribute('data-fig-n') || '');
      f.mode = 'kit';
      /* the loop is the kit's (diagrams.js startLoop); stop it with the figure on route change */
      f.stop = () => { try { BS.diagrams.loopOf?.(host)?.stop?.(); } catch { /* already gone */ } };
    }
    /* back to the server's empty figure: observers and the kit's loop and draw-in stopped, and the kit's
       record dropped so its own 720 px watcher leaves the host alone */
    function clearFig(f: Fig) {
      const el = f.el;
      f.stop(); f.stop = () => {};
      try { BS.diagrams.loopOf?.(el)?.stop?.(); } catch { /* already gone */ }
      try { el.__dg?.stop?.(); } catch { /* already gone */ }
      delete el.__dg;
      el.querySelectorAll(':scope > .fig__art, :scope > figcaption').forEach((n) => n.remove());
      el.classList.remove('is-armed', 'is-drawn', 'is-settled', 'is-dg-fading', 'is-nofx', 'is-paused', 'is-visible');
      ['data-dg-ready', 'data-dg-rate', 'data-dg-engine', 'data-dg-loop', 'data-dg-phase', 'data-fig-mode'].forEach((a) => el.removeAttribute(a));
      ['--labels-delay', '--labels-at', '--dg-loop-fade'].forEach((p) => el.style.removeProperty(p));
      f.mode = '';
    }
    function gifFig(f: Fig, still: boolean) {
      const el = f.el, g = GIFS[f.name]!;
      const src = '/kit/brand/fig-' + f.name + (still ? '-still.webp' : '.gif');
      /* what the kit gives its host, so the .fig and .hiw-fig rules apply unchanged */
      el.classList.add('fig');
      el.setAttribute('data-diagram', f.name);
      el.setAttribute('data-fig-mode', still ? 'still' : 'gif');
      const art = document.createElement('div');
      art.className = 'fig__art';
      const img = document.createElement('img');
      img.className = 'hiw-fig__img';
      img.alt = figLabel(f.name, f.opts);
      img.decoding = 'async';
      img.draggable = false;
      img.width = g.w;
      img.height = g.h;
      art.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.className = 'fig__caption';
      cap.setAttribute('data-n', el.getAttribute('data-fig-n') || '');
      cap.textContent = g.caption;
      el.append(art, cap);
      f.mode = still ? 'still' : 'gif';
      if (still) { img.src = src; return; }
      let live = true, started = false;
      const root: HTMLElement | null = M.scrollRoot ? M.scrollRoot() : null;
      const ios: IntersectionObserver[] = [];
      const once = (rootMargin: string, fn: () => void) => {
        const io = new IntersectionObserver((es) => {
          if (!es.some((e) => e.isIntersecting)) return;
          io.disconnect();
          fn();
        }, { root, rootMargin });
        io.observe(el);
        ios.push(io);
      };
      once('0px 0px -12% 0px', () => {
        started = true;
        Promise.resolve(M.whenUncovered ? M.whenUncovered() : undefined).then(() => { if (live) img.src = src; });
      });
      once('0px 0px 100% 0px', () => {
        /* a figure already across the start line (in view on mount) is loaded by the start itself */
        const top = el.getBoundingClientRect().top - (root ? root.getBoundingClientRect().top : 0);
        if (started || warmed.has(src) || top < (root ? root.clientHeight : window.innerHeight) * 0.88) return;
        warmed.add(src);
        fetch(src).then((r) => r.arrayBuffer()).catch(() => { warmed.delete(src); /* the start loads it anyway */ });
      });
      f.stop = () => { live = false; ios.forEach((io) => io.disconnect()); };
    }
    function build(f: Fig) {
      const w = want();
      if (w === f.mode) return;
      clearFig(f);
      if (w === 'kit') kitFig(f); else gifFig(f, w === 'still');
    }
    const figs: Fig[] = [];
    FIGS.forEach((d) => {
      const el = $<FigHost>(d[0]); if (!el) return;
      const f: Fig = { el, name: d[1], opts: d[2], mode: '', stop: () => {} };
      /* a re-run on a figure the kit already drew updates it in place, as before */
      if (el.__dg && want() === 'kit') kitFig(f); else build(f);
      figs.push(f);
    });
    const rebuild = () => figs.forEach(build);
    on(narrowMq, 'change', rebuild);
    on(document, 'bs:motion', rebuild);
    cleanups.push(() => figs.forEach((f) => { if (f.mode === 'kit') f.stop(); else clearFig(f); }));
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
