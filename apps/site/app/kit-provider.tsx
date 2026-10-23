'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';

// The ONE place the kit is mounted. The kit JS (window.BS) loads via <Script> in the layout; the
// mockups run their mount sequence on DOMContentLoaded — here it runs after hydration and again on
// every route change, idempotently, in the same order:
//   syncMotionAttr → mountSite (frame, notch nav with wings/row/pill, footer, hero rise, spaces
//   incl. the CRT hero with the nebula fallback) → icons → glass.decorate → spaces for new hosts →
//   mountReveals → mountDrawIn → mountPause → diagrams.
// Elements already handled carry a data-kit marker, so route changes never re-animate.
type BSKit = {
  motion?: { syncMotionAttr?: () => void; mountReveals?: (scope: Node) => void; mountDrawIn?: (el: Element) => void; mountPause?: (el: Element) => void; reduced?: () => boolean };
  glass?: { decorate?: (root: Node) => void };
  icons?: () => void;
  mountSite?: (o: unknown) => unknown;
  site?: { setActive?: (id: string, o?: { animate?: boolean }) => void; refs?: { notch?: HTMLElement } };
  mountSpace?: (host: Element, o: { intensity: string; fade?: boolean }) => unknown;
  mountCRT?: (host: Element, o?: unknown) => unknown;
  diagrams?: { render?: (name: string, host: Element, o: unknown) => void };
};

const ROUTES = { home: '/', how: '/how-it-works', verify: '/verify', docs: '/docs', explorer: '/explorer', changelog: '/changelog' };
export const DASHBOARD_URL = 'http://127.0.0.1:7777';

function activeFor(path: string): keyof typeof ROUTES {
  if (path === '/') return 'home';
  const seg = path.split('/')[1];
  return (['how-it-works', 'verify', 'docs', 'explorer', 'changelog'].includes(seg) ? ({ 'how-it-works': 'how' } as Record<string, string>)[seg] ?? seg : 'home') as keyof typeof ROUTES;
}

function mountSequence(BS: BSKit, firstMount: boolean, active: string) {
  const once = (el: HTMLElement, key: string, fn: (el: HTMLElement) => void) => {
    const k = `kit${key}`;
    if (el.dataset[k]) return;
    el.dataset[k] = '1';
    try { fn(el); } catch { /* a kit module missing is not fatal */ }
  };
  try { BS.motion?.syncMotionAttr?.(); } catch {}
  if (firstMount) {
    try { BS.mountSite?.({ active, routes: ROUTES, action: { label: 'Open dashboard', href: DASHBOARD_URL } }); } catch {}
    // the dashboard is local-first: open it in a new tab, never navigate the site away
    document.querySelectorAll<HTMLAnchorElement>('[data-site-cta]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  } else {
    try { BS.site?.setActive?.(active, { animate: true }); } catch {}
  }
  try { BS.icons?.(); } catch {}
  try { BS.glass?.decorate?.(document); } catch {}
  // spaces/CRT for hosts mountSite did not see (pages rendered after the first mount)
  document.querySelectorAll<HTMLElement>('.hero__space, [data-space]').forEach((host) => {
    if (host.hasAttribute('data-space-mounted')) return;
    host.setAttribute('data-space-mounted', '');
    const wantCrt = host.getAttribute('data-bg') === 'crt';
    if (wantCrt && BS.mountCRT?.(host, {})) return;
    if (wantCrt) host.dataset.bg = 'nebula';
    const i = host.getAttribute('data-intensity') || host.getAttribute('data-space') || 'hero';
    try { BS.mountSpace?.(host, { intensity: i === 'faint' ? 'faint' : 'hero', fade: host.getAttribute('data-fade') !== 'false' }); } catch {}
  });
  try { BS.motion?.mountReveals?.(document); } catch {}
  document.querySelectorAll<HTMLElement>('[data-draw-in], .draw-in').forEach((el) => once(el, 'Draw', (e) => BS.motion?.mountDrawIn?.(e)));
  document.querySelectorAll<HTMLElement>('[data-pause]').forEach((el) => once(el, 'Pause', (e) => BS.motion?.mountPause?.(e)));
  document.querySelectorAll<HTMLElement>('[data-figure]').forEach((el) => once(el, 'Figure', (e) => BS.diagrams?.render?.(e.dataset.figure!, e, {})));
}

let mounted = false;
const kitReady = () => !!(window as unknown as { BS?: BSKit }).BS?.mountSite;

export function KitProvider() {
  const path = usePathname();
  // the bundle loads after hydration; on client-side navigations it is already there
  const [ready, setReady] = useState(false);
  useEffect(() => { if (kitReady()) setReady(true); }, []);
  useEffect(() => {
    if (!ready) return;
    const BS = (window as unknown as { BS?: BSKit }).BS;
    if (!BS) return;
    const first = !mounted; mounted = true;
    // next frame, so React's DOM for this route is final before the kit decorates it
    const raf = requestAnimationFrame(() => mountSequence(BS, first, activeFor(path)));
    return () => cancelAnimationFrame(raf);
  }, [ready, path]);
  return <Script src="/kit/kit.js" strategy="afterInteractive" onLoad={() => setReady(true)} />;
}
