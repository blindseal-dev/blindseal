'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// The phone menu (< 720 px). Its markup — the button in the header row and the full-screen sheet — is
// server-rendered with the chrome (kit/site-templates.cjs → site-chrome.tsx); this component renders
// nothing and only wires it, so it works with or without the kit and creates nothing in html/head/body.
// Open: aria-expanded, the sheet unhidden, focus to its first link, Tab /
// Shift+Tab kept inside (button + sheet links), Escape closes and returns focus to the button. Leaving
// phone width or changing route closes it.
// Scroll lock while open: the page behind must not scroll (iOS Safari ignores overflow:hidden on body
// for touch scrolling), so <body> is pinned with position:fixed at -scrollY — inline styles on body
// only, never on <html> — and on every close path the styles are removed and the exact scroll position
// is restored with behavior 'instant' (html.bs-site has scroll-behavior: smooth).
const MQ = '(max-width: 719.98px)';

export function SiteMenu() {
  const path = usePathname();
  useEffect(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-site-menu-btn]');
    const sheet = btn && document.getElementById(btn.getAttribute('aria-controls') || '');
    if (!btn || !sheet) return;
    const mq = window.matchMedia(MQ);
    const focusables = () => [btn, ...Array.from(sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))];
    const markCurrent = () => {
      const seg = location.pathname.split('/')[1] || '';
      sheet.querySelectorAll<HTMLAnchorElement>('a[data-site-menu-link]').forEach((a) => {
        const on = (a.getAttribute('href') || '').split('/')[1] === seg && seg !== '';
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); set(false, true); return; }
      if (e.key !== 'Tab') return;
      // the cycle is explicit (button → links → button), so it holds where Tab skips links (Safari's default)
      e.preventDefault();
      const list = focusables(); const i = list.indexOf(document.activeElement as HTMLElement);
      const n = list.length, next = i === -1 ? 0 : (i + (e.shiftKey ? -1 : 1) + n) % n;
      list[next]!.focus();
    };
    let open = false;
    let savedY = 0;
    const LOCK = ['position', 'top', 'left', 'right', 'width', 'overflow'] as const;
    const lock = () => {
      savedY = window.scrollY;
      const b = document.body.style;
      b.position = 'fixed'; b.top = `-${savedY}px`; b.left = '0'; b.right = '0'; b.width = '100%'; b.overflow = 'hidden';
    };
    const unlock = () => {
      const b = document.body.style;
      LOCK.forEach((k) => b.removeProperty(k));
      window.scrollTo({ top: savedY, left: 0, behavior: 'instant' as ScrollBehavior });
    };
    function set(v: boolean, restore: boolean) {
      if (v === open) return;
      open = v;
      sheet!.hidden = !v;
      btn!.setAttribute('aria-expanded', String(v));
      if (v) {
        lock();
        markCurrent();
        document.addEventListener('keydown', onKey, true);
        sheet!.scrollTop = 0;
        sheet!.querySelector<HTMLElement>('a[href]')?.focus();
      } else {
        document.removeEventListener('keydown', onKey, true);
        unlock();
        if (restore) btn!.focus({ preventScroll: true });
      }
    }
    const onBtn = () => set(!open, true);
    // a link to the page already shown just closes the sheet (other links load their page)
    const onSheet = (e: MouseEvent) => { if ((e.target as Element).closest('a[href]')) set(false, false); };
    const onMq = () => { if (!mq.matches) set(false, false); };
    btn.addEventListener('click', onBtn);
    sheet.addEventListener('click', onSheet);
    mq.addEventListener('change', onMq);
    return () => {
      set(false, false);
      btn.removeEventListener('click', onBtn);
      sheet.removeEventListener('click', onSheet);
      mq.removeEventListener('change', onMq);
    };
  }, [path]);
  return null;
}
