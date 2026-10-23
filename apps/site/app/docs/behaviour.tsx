'use client';
import { usePathname } from 'next/navigation';
import { usePageKit } from '../use-page-kit';

// S04's page.js, the parts the server cannot render: the outline's scroll progress fill (scaleY, damped
// 100 ms linear) and scroll-spy (IO band −20 % / −70 %, deepest target wins, nothing above the first
// section, the last target at the very bottom, a clicked target pinned until the reader scrolls), back to
// top, the heading anchors (copy the link, a check for 1400 ms), and the page transitions: the first paint
// rises (.docs / .docs-page.is-rising), later route changes fade the page and the outline in (.is-arriving).
let painted = false;

export function DocsBehaviour() {
  const path = usePathname();
  usePageKit((BS) => {
    const M = BS.motion, ui = BS.ui;
    const reduced = () => !!M?.reduced?.();
    const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null;
    const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
    const docs = $('[data-docs]'), pageEl = $('[data-doc]'), listEl = $('[data-otp-list]'), fill = $('[data-fill]'), topBtn = $<HTMLButtonElement>('[data-top]');
    if (!docs || !pageEl || !listEl || !fill || !topBtn) return;
    const offs: (() => void)[] = [];
    const on = <K extends keyof WindowEventMap>(t: Window | Document, ev: K, fn: (e: WindowEventMap[K]) => void, o?: AddEventListenerOptions) => {
      (t as Window).addEventListener(ev, fn as EventListener, o); offs.push(() => (t as Window).removeEventListener(ev, fn as EventListener, o));
    };

    /* ── first paint vs a page swap ─────────────────────────────────────── */
    if (!painted) {
      painted = true;
      if (!reduced()) { docs.classList.add('is-rising'); pageEl.classList.add('is-rising'); }
      /* a section that starts inside the first screen rises with it: the kit's reveal band ends at 88 %
         of the viewport, which would leave a section whose head peeks in at the fold hidden until a scroll */
      $$('.reveal:not(.is-inview)', pageEl).forEach((el) => { if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-inview'); });
    } else if (!reduced()) {
      M?.restart?.(pageEl, 'is-arriving'); M?.restart?.(listEl, 'is-arriving');
      const t = setTimeout(() => { pageEl.classList.remove('is-arriving'); listEl.classList.remove('is-arriving'); }, (M?.scale?.(200) ?? 200) + 40);
      offs.push(() => clearTimeout(t));
    }

    /* ── the outline: fill + scroll-spy ─────────────────────────────────── */
    const linkMap: Record<string, HTMLElement> = {}, parentOf: Record<string, string> = {};
    let lastTop = '';
    $$('[data-otp]', listEl).forEach((a) => {
      const id = a.getAttribute('data-otp')!; linkMap[id] = a;
      if (a.classList.contains('is-sub')) parentOf[id] = lastTop; else lastTop = id;
    });
    const targetsEls = $$('[data-target]', pageEl).filter((el) => linkMap[el.id]);
    const visible: Record<string, 1> = {};
    let ioActive = '', active: string | null = null, atBottom = false, pinned = '';
    const setActive = (id: string) => {
      if (id === active) return;
      active = id;
      const par = parentOf[id];
      Object.keys(linkMap).forEach((k) => {
        const a = linkMap[k], isOn = k === id;
        a.classList.toggle('is-active', isOn); a.classList.toggle('is-parent', k === par);
        if (isOn) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    };
    const spy = () => {
      if (pinned && linkMap[pinned]) return setActive(pinned);
      if (!targetsEls.length) return setActive('');
      if (atBottom) return setActive(targetsEls[targetsEls.length - 1].id);
      if (targetsEls[0].getBoundingClientRect().top > window.innerHeight * 0.3) return setActive('');
      setActive(ioActive);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; });
      ioActive = '';
      for (let i = targetsEls.length - 1; i >= 0; i--) if (visible[targetsEls[i].id]) { ioActive = targetsEls[i].id; break; }
      spy();
    }, { rootMargin: '-20% 0px -70% 0px' });
    targetsEls.forEach((el) => io.observe(el));
    offs.push(() => io.disconnect());

    let pend = 0;
    const onScroll = () => {
      pend = 0;
      const se = document.scrollingElement || document.documentElement;
      const max = se.scrollHeight - window.innerHeight, y = window.scrollY;
      const pct = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
      fill.style.transform = `scaleY(${pct.toFixed(4)})`;
      atBottom = max > 0 && max - y < 2;
      topBtn.disabled = y < 8;
      spy();
    };
    const queue = () => { if (!pend) pend = requestAnimationFrame(onScroll); };
    on(window, 'scroll', queue, { passive: true });
    on(window, 'resize', queue);
    offs.push(() => { if (pend) cancelAnimationFrame(pend); });

    /* a clicked outline target stays lit until the reader scrolls by hand */
    const unpin = () => { pinned = ''; };
    on(window, 'wheel', unpin, { passive: true });
    on(window, 'touchstart', unpin, { passive: true });
    on(document, 'keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| |Spacebar)$/.test(e.key) && !(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) unpin();
    });

    /* ── jump to an anchor inside the page ──────────────────────────────── */
    const jump = (id: string, o: { instant?: boolean; noFocus?: boolean } = {}) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'DETAILS') (el as HTMLDetailsElement).open = true;
      const pin = linkMap[id] ? id : ((el.closest('[data-target]') as HTMLElement | null)?.id || '');
      if (pin && linkMap[pin]) { pinned = pin; setActive(pin); }
      el.scrollIntoView({ behavior: reduced() || o.instant ? 'instant' : 'smooth', block: 'start' });
      try { history.replaceState(null, '', location.pathname + location.search + '#' + id); } catch {}
      const h = el.matches('h1,h2,h3') ? el : el.querySelector<HTMLElement>('h2, h3, summary');
      if (h && !o.noFocus) { if (!h.matches('summary')) h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    };

    /* ── delegated clicks: outline links, heading anchors ───────────────── */
    on(document, 'click', (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      const t = e.target as HTMLElement;
      const ol = t.closest('a[data-otp]');
      if (ol) { e.preventDefault(); jump(ol.getAttribute('data-otp')!); return; }
      const an = t.closest('[data-anchor]') as (HTMLElement & { _t?: number; _label?: string | null }) | null;
      if (an) {
        e.preventDefault();
        const id = an.getAttribute('data-anchor')!;
        const url = location.origin + location.pathname + '#' + id;
        const done = () => {
          if (an._t) clearTimeout(an._t);
          if (an._label == null) an._label = an.getAttribute('aria-label');
          an.classList.add('is-done'); an.innerHTML = BS.icon?.('check') ?? ''; an.setAttribute('aria-label', 'Link copied');
          an._t = window.setTimeout(() => { an.classList.remove('is-done'); an.innerHTML = BS.icon?.('link') ?? ''; an.setAttribute('aria-label', an._label || ''); an._label = null; }, 1400);
          document.dispatchEvent(new CustomEvent('bs:copy', { detail: { value: url } }));
        };
        if (ui?.writeClipboard) ui.writeClipboard(url, done); else navigator.clipboard?.writeText(url).then(done).catch(() => {});
      }
    });
    const toTop = () => {
      window.scrollTo({ top: 0, behavior: reduced() ? 'instant' : 'smooth' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
      const t = $('#docs-title', pageEl); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); }
    };
    topBtn.addEventListener('click', toTop); offs.push(() => topBtn.removeEventListener('click', toTop));

    /* ── first paint: a hash in the URL lands on its target ─────────────── */
    const initialHash = (location.hash || '').slice(1);
    if (initialHash && document.getElementById(initialHash)) M?.raf2?.(() => jump(initialHash, { instant: true, noFocus: true }));
    onScroll();
    return () => { offs.forEach((f) => f()); };
  }, [path]);
  return null;
}
