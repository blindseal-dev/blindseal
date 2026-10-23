'use client';
import { usePageKit } from '../use-page-kit';

// S06 · Changelog — the mockup's page.js, run once the kit has mounted the chrome (use-page-kit.ts).
// The entries and the rail are server-rendered by page.tsx; this adds, in page.js's order:
//   1. anchors      the ids page.tsx assigned, plus the #v<version>-<component> aliases.
//   2. deep links   on load (and on hashchange) the entry is scrolled to instantly, revealed, and
//                   the rail is lit for it; an alias is canonicalised, an unknown fragment stripped.
//   3. scroll-spy   one rAF scroll handler: the active entry is the last whose activation point the
//                   reader has passed; entries the page cannot scroll to the top (the last screenful)
//                   get activation points spread evenly over the remaining scroll.
//   4. rail links   smooth-scroll (instant under reduced motion or from the keyboard), update the
//                   hash, focus the entry's version; the spy holds on the target until the scroll ends.
//   5. "#" buttons  copy the entry's absolute URL through the kit's [data-copy] helper ("Copied",
//                   1.4 s) and set the hash in place. The URL is written here, never on the server.
//   6. reveals      once per entry: the entries in view on first paint rise-14 at 260 + 60 ms × n;
//                   the rest rise-14 (no delay) the first time they enter the viewport.
// The footer's version (rendered by BS.mountSite) is rewritten from the newest release and links to it.
export type Entry = { id: string; version: string; component: string; date: string };

const REVEAL_BASE = 260, REVEAL_STEP = 60;

export function ChangelogKit({ entries: LOG }: { entries: Entry[] }) {
  usePageKit((BS) => {
    const M = BS.motion, ui = BS.ui;
    const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null;
    const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
    const esc = (s: string) => ui.esc(s) as string;
    const reduced = () => !!M.reduced();
    const replace = (url: string) => { try { history.replaceState(null, '', url); } catch { /* opaque origin */ } };
    const cleanups: Array<() => void> = [];
    const on = (t: EventTarget, type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
      t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o));
    };

    /* ── ids + aliases ─────────────────────────────────────────────────── */
    const alias: Record<string, string> = {};
    LOG.forEach((e) => {
      alias[e.id] = e.id;
      const long = 'v' + e.version + '-' + e.component;
      if (!alias[long]) alias[long] = e.id;
    });
    const latest = LOG[0] || null;
    const urlFor = (id: string) => location.origin + location.pathname + '#' + id;

    const list = $('#cl-entries'), rail = $('#cl-rail-list');
    const fill = $('.cl-rail__fill'), topBtn = $<HTMLButtonElement>('[data-top]');
    if (!list || !rail || !fill || !topBtn) return;
    const entries = $$('.cl-entry', list);
    const links = $$<HTMLAnchorElement>('.cl-rail__link', rail);

    /* ── "#" buttons: the absolute URL, then the kit's copy helper ─────── */
    $$('.cl-anchor', list).forEach((b) => { b.setAttribute('data-copy', urlFor(b.getAttribute('data-anchor') || '')); });
    try { ui.copy(list); } catch { /* the document-level delegate wires on click */ }

    /* ── footer version = the latest entry ─────────────────────────────── */
    const verEl = $('.site-footer__ver');
    if (verEl && latest) {
      const orig = verEl.innerHTML;
      const rest = (verEl.textContent || '').replace(/^v\S+/, '');
      verEl.innerHTML = '<a href="#' + esc(latest.id) + '" data-go="' + esc(latest.id) + '">v' + esc(latest.version) + '</a>' + esc(rest);
      cleanups.push(() => { verEl.innerHTML = orig; });
    }

    /* ── masthead field + the ladder ───────────────────────────────────── */
    const mast = $('.cl-mast'), body = $('#cl'), space = $('.cl-mast__space');
    if (space && BS.mountSpace && !space.hasAttribute('data-space-mounted')) { space.setAttribute('data-space-mounted', ''); BS.mountSpace(space, { intensity: 'faint', fade: false }); }
    if (!reduced()) { mast?.classList.add('is-rising'); body?.classList.add('is-rising'); }

    /* ── geometry: targets + activation points ─────────────────────────── */
    let act: number[] = [], lead: number[] = [], maxY = 0;
    const padTop = () => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 78;
    function measure() {
      const se = document.scrollingElement || document.documentElement;
      maxY = Math.max(0, se.scrollHeight - window.innerHeight);
      const pad = padTop();
      /* layout tops (offsetTop chain), so a rising entry's 14 px transform never skews them */
      const t = entries.map((el) => { let top = 0; let n: HTMLElement | null = el; while (n) { top += n.offsetTop; n = n.offsetParent as HTMLElement | null; } return Math.round(top - pad); });
      act = t.slice();
      let j = -1;
      for (let i = 0; i < t.length; i++) { if (t[i] > maxY - 1) { j = i; break; } }
      if (j >= 0) {
        /* start the spread early enough that each step gets ≥ 100 px of scroll */
        let s = Math.max(0, j - 1);
        while (s > 0 && (maxY - Math.min(t[s], maxY)) / (t.length - 1 - s) < 100) s--;
        const from = Math.min(t[s], maxY), n = t.length - 1 - s;
        for (let k = s + 1; k < t.length; k++) act[k] = Math.round(from + (maxY - from) * (k - s) / n);
      }
      /* lead: an entry lights a little before it reaches the top, but never by more than half the
         scroll since the previous one, so a jump to entry i always lights i, never i + 1 */
      lead = act.map((a, i) => (i ? Math.max(0, Math.min(160, Math.floor((a - act[i - 1]) / 2) - 1)) : 0));
    }

    /* ── scroll-spy ────────────────────────────────────────────────────── */
    let active = -1, hold = -1, holdTimer = 0;
    function setActive(i: number) {
      if (i === active) return;
      active = i;
      links.forEach((a, k) => {
        const isOn = k === i;
        a.classList.toggle('is-active', isOn);
        if (isOn) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    }
    function spyIndex() {
      const y = window.scrollY; let idx = 0;
      for (let i = 0; i < act.length; i++) { if (y + lead[i] >= act[i] - 1) idx = i; }
      return idx;
    }
    let pend = 0;
    function onScroll() {
      pend = 0;
      const y = window.scrollY;
      const p = maxY > 0 ? Math.min(1, Math.max(0, y / maxY)) : 0;
      fill!.style.transform = 'scaleY(' + p.toFixed(4) + ')';
      topBtn!.disabled = y < 8;
      if (hold >= 0) {
        setActive(hold);
        if (Math.abs(y - act[hold]) < 2) release();
        return;
      }
      setActive(spyIndex());
    }
    function schedule() { if (!pend) pend = requestAnimationFrame(onScroll); }
    function release() { hold = -1; clearTimeout(holdTimer); }
    on(window, 'scroll', schedule, { passive: true });
    on(window, 'scrollend', () => { if (hold >= 0) { release(); schedule(); } });
    ['wheel', 'touchstart', 'keydown'].forEach((t) => on(window, t, () => { if (hold >= 0) { release(); schedule(); } }, { passive: true }));
    on(window, 'resize', () => { measure(); schedule(); });

    /* ── reveals: once per entry ───────────────────────────────────────── */
    let io: IntersectionObserver | null = null;
    function show(el: HTMLElement, delay: number) {
      if (el.classList.contains('is-in')) return;
      if (!reduced()) { el.style.animationDelay = delay + 'ms'; el.classList.add('rise-14'); }
      el.classList.add('is-in');
      if (io) io.unobserve(el);
    }
    function firstPaint() {
      if (reduced() || !('IntersectionObserver' in window)) { entries.forEach((el) => show(el, 0)); return; }
      let n = 0; const h = window.innerHeight;
      entries.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top < h * 0.88 && r.bottom > 0) show(el, REVEAL_BASE + REVEAL_STEP * n++);
      });
      io = new IntersectionObserver((hits) => {
        hits.forEach((e) => { if (e.isIntersecting) show(e.target as HTMLElement, 0); });
      }, { rootMargin: '0px 0px -12% 0px' });
      entries.forEach((el) => { if (!el.classList.contains('is-in')) io!.observe(el); });
    }

    /* ── navigation ────────────────────────────────────────────────────── */
    const indexOf = (id: string) => LOG.findIndex((e) => e.id === id);
    function resolveHash(h: string) {
      h = decodeURIComponent(String(h || '').replace(/^#/, ''));
      return alias[h] ? indexOf(alias[h]) : -1;
    }
    function go(i: number, o: { instant?: boolean; hash?: boolean; focus?: boolean } = {}) {
      if (i < 0 || !entries[i]) return;
      measure();
      const smooth = !o.instant && !reduced();
      const target = act[i];
      if (smooth && Math.abs(window.scrollY - target) > 2) {
        hold = i; clearTimeout(holdTimer);
        holdTimer = window.setTimeout(() => { release(); schedule(); }, M.scale(1600));
      }
      window.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'instant' });
      setActive(i);
      if (o.hash !== false) replace('#' + LOG[i].id);
      if (o.focus) { const h = $('.cl-entry__v', entries[i]); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
      show(entries[i], 0);
      schedule();
    }
    const plain = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1);
    links.forEach((a, i) => {
      on(a, 'click', ((e: MouseEvent) => {
        if (!plain(e)) return;
        e.preventDefault();
        go(i, { focus: true, instant: e.detail === 0 });     /* keyboard activation: no animation */
      }) as EventListener);
    });
    on(document, 'click', ((e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-go]');
      if (!a || !plain(e)) return;
      e.preventDefault();
      go(indexOf(a.getAttribute('data-go') || ''), { focus: true, instant: e.detail === 0 });
    }) as EventListener);
    on(list, 'click', ((e: MouseEvent) => {
      const b = (e.target as Element | null)?.closest?.('.cl-anchor');
      if (!b) return;
      replace('#' + b.getAttribute('data-anchor'));
    }) as EventListener);
    on(topBtn, 'click', ((e: MouseEvent) => {
      release();
      window.scrollTo({ top: 0, behavior: reduced() || e.detail === 0 ? 'instant' : 'smooth' });
      replace(location.pathname + location.search);
      const t = $('#cl-title'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); }
    }) as EventListener);
    on(window, 'hashchange', () => {
      const i = resolveHash(location.hash);
      if (i >= 0) go(i, { instant: true });                 /* canonicalises an alias (#v0.4.0-proxy → #v0.4.0) */
      else stripUnknown();
    });

    /* ── boot: deep link first (so the right entries rise), then the spy ── */
    const prevRestoration = 'scrollRestoration' in history ? history.scrollRestoration : null;
    if (prevRestoration) history.scrollRestoration = 'manual';
    measure();
    /* an unknown fragment (#nope) leaves the address bar, as an alias is rewritten;
       a fragment naming a real element (the skip link's #main-content) stays */
    function stripUnknown() {
      const h = decodeURIComponent(location.hash.slice(1));
      if (!h || document.getElementById(h)) return;
      replace(location.pathname + location.search);
    }
    const deep = resolveHash(location.hash); let userMoved = false;
    if (deep < 0) stripUnknown();
    if (deep >= 0) {
      window.scrollTo({ top: act[deep], behavior: 'instant' });
      if (LOG[deep].id !== location.hash.slice(1)) replace('#' + LOG[deep].id);
    }
    firstPaint();
    onScroll();
    ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((t) => on(window, t, () => { userMoved = true; }, { passive: true }));
    /* fonts and the browser's own fragment jump can move things after boot:
       re-measure, and keep a deep link pinned until the reader moves */
    let alive = true;
    function settle() {
      if (!alive) return;
      measure();
      if (deep >= 0 && !userMoved) window.scrollTo({ top: act[deep], behavior: 'instant' });
      schedule();
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
    if (document.readyState === 'complete') requestAnimationFrame(settle);   /* the kit mounts after load here */
    else on(window, 'load', settle);

    const pageApi = {
      entries: LOG.map((e) => ({ id: e.id, version: e.version, component: e.component, date: e.date })),
      latest: latest && latest.id,
      active: () => (active >= 0 ? LOG[active].id : null),
      go: (id: string) => { go(resolveHash(id)); },
      activation: () => act.slice(),
    };
    BS.page = pageApi;

    return () => {
      alive = false;
      cleanups.forEach((fn) => fn());
      if (io) io.disconnect();
      if (pend) cancelAnimationFrame(pend);
      clearTimeout(holdTimer);
      if (prevRestoration) history.scrollRestoration = prevRestoration;
      if (BS.page === pageApi) delete BS.page;
    };
  });
  return null;
}
