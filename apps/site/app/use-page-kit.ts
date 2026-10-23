'use client';
import { useEffect } from 'react';

// The site-side home of each mockup's page.js. A page calls usePageKit(fn): fn runs once window.BS
// exists AND KitProvider has run its mount sequence for the current route (the `bs:route-mounted`
// event), so the chrome, icons and reveals already exist when the page paints its own parts; fn may
// return a cleanup. decorate(scope) applies the kit to markup the page injected after that point
// (icons → glass → reveals), exactly what the mockups' DOMContentLoaded boots did for static markup.
export type BSAny = Record<string, any>;
export const bs = (): BSAny | undefined => (typeof window === 'undefined' ? undefined : (window as any).BS);
export const kitMounted = (): boolean => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-kit-mounted');

export function decorate(scope: ParentNode = document) {
  const BS = bs(); if (!BS) return;
  try { BS.icons?.(); } catch {}
  try { BS.glass?.decorate?.(scope); } catch {}
  try { BS.motion?.mountReveals?.(scope); } catch {}
  scope.querySelectorAll?.('[data-draw-in], .draw-in').forEach((el) => { if (!(el as HTMLElement).dataset.kitDraw) { (el as HTMLElement).dataset.kitDraw = '1'; try { BS.motion?.mountDrawIn?.(el); } catch {} } });
}

export function usePageKit(fn: (BS: BSAny) => void | (() => void), deps: unknown[] = []) {
  useEffect(() => {
    let cleanup: void | (() => void);
    let done = false;
    const run = () => { if (done) return; const BS = bs(); if (!BS?.mountSite) return; done = true; try { cleanup = fn(BS); } catch (e) { console.error(e); } };
    if (kitMounted()) run();
    window.addEventListener('bs:route-mounted', run);
    return () => { window.removeEventListener('bs:route-mounted', run); if (typeof cleanup === 'function') cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
