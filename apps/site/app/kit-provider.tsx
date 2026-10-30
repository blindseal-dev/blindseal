'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ROUTES } from './routes';
export { ROUTES };

// The ONE place the kit is mounted. The kit JS (window.BS) is injected from a useEffect — i.e. only
// after React has hydrated — and no kit module does anything at load (every
// boot()/mount()/observer was stripped from the modules), so the kit can never touch React-owned DOM
// mid-hydration. The mockups ran their mount sequence on DOMContentLoaded — here it runs once the
// script has loaded and again on every route change, idempotently, in the same order:
//   syncMotionAttr → mountSite (frame, the pill nav with its sliding white pill, hero rise, spaces
//   incl. the banner / CRT hero with the nebula fallback) → icons → glass.decorate → spaces for new
//   hosts (BS.site.mountSpaces, the kit's own loop) → mountReveals → mountDrawIn → mountPause → diagrams.
// Elements already handled carry a data-kit marker, so route changes never re-animate.
type BSKit = {
  motion?: { boot?: () => void; syncMotionAttr?: () => void; mountReveals?: (scope: Node) => void; mountDrawIn?: (el: Element) => void; mountPause?: (el: Element) => void; reduced?: () => boolean };
  glass?: { decorate?: (root: Node) => void; boot?: (root?: Node) => void };
  icons?: ((root?: Node) => void) & { boot?: (root?: Node) => void };
  ui?: { copy?: () => void };
  mountSite?: (o: unknown) => unknown;
  site?: { setActive?: (id: string, o?: { animate?: boolean }) => void; refs?: { notch?: HTMLElement }; mountSpaces?: () => void };
  diagrams?: { render?: (name: string, host: Element, o: unknown) => void };
};


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
  try { (BS.motion?.boot ?? BS.motion?.syncMotionAttr)?.(); } catch {}
  if (firstMount) {
    try { BS.mountSite?.({ active, routes: ROUTES }); } catch {}
  } else {
    try { BS.site?.setActive?.(active, { animate: true }); } catch {}
  }
  try { (BS.icons?.boot ?? BS.icons)?.(document); } catch {}
  try { (BS.glass?.boot ?? BS.glass?.decorate)?.(document); } catch {}
  try { BS.ui?.copy?.(); } catch {}          // [data-copy] buttons (the mockups wired these on DOMContentLoaded)
  // spaces for hosts mountSite did not see (pages rendered after the first mount, on client-side navigation):
  // the kit's own loop (site.js mountSpaces), which knows every hero background — data-bg="banner" (Home,
  // round 2), "crt" (the nebula at phone width or without WebGL2) and the nebula — and skips mounted hosts
  try { BS.site?.mountSpaces?.(); } catch {}
  try { BS.motion?.mountReveals?.(document); } catch {}
  document.querySelectorAll<HTMLElement>('[data-draw-in], .draw-in').forEach((el) => once(el, 'Draw', (e) => BS.motion?.mountDrawIn?.(e)));
  document.querySelectorAll<HTMLElement>('[data-pause]').forEach((el) => once(el, 'Pause', (e) => BS.motion?.mountPause?.(e)));
  document.querySelectorAll<HTMLElement>('[data-figure]').forEach((el) => once(el, 'Figure', (e) => BS.diagrams?.render?.(e.dataset.figure!, e, {})));
  // pages hook here (use-page-kit.ts): their page.js-equivalents run after the chrome and reveals exist
  document.body.setAttribute('data-kit-mounted', '1');   // body, never html: the kit writes nothing on <html>/<head>/body children
  window.dispatchEvent(new CustomEvent('bs:route-mounted', { detail: { active } }));
}

let mounted = false;
const kitReady = () => !!(window as unknown as { BS?: BSKit }).BS?.mountSite;

export function KitProvider() {
  const path = usePathname();
  // the bundle loads after hydration; on client-side navigations it is already there
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (kitReady()) { setReady(true); return; }
    let s = document.querySelector<HTMLScriptElement>('script[data-bs-kit]');
    if (!s) { s = document.createElement('script'); s.src = '/kit/kit.js'; s.async = true; s.dataset.bsKit = '1'; document.head.appendChild(s); }
    const onLoad = () => setReady(true);
    s.addEventListener('load', onLoad);
    return () => s!.removeEventListener('load', onLoad);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const BS = (window as unknown as { BS?: BSKit }).BS;
    if (!BS) return;
    const first = !mounted; mounted = true;
    // next frame, so React's DOM for this route is final before the kit decorates it
    const raf = requestAnimationFrame(() => mountSequence(BS, first, activeFor(path)));
    return () => cancelAnimationFrame(raf);
  }, [ready, path]);
  return null;
}
