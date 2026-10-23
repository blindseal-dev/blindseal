'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// The kit JS is loaded via <Script> tags in the layout (populating window.BS). After each route we
// boot icons/glass/reveal/space and render any data-figure / data-bg hosts.
export function KitBoot() {
  const path = usePathname();
  useEffect(() => {
    const BS = (window as unknown as { BS?: any }).BS;
    if (!BS) return;
    const run = () => {
      try { BS.icons?.(); } catch {}
      try { BS.glass?.decorate?.(); } catch {}
      try { BS.reveal?.(); } catch {}
      document.querySelectorAll<HTMLElement>('[data-bg]').forEach((h) => { try { if (!h.dataset.mounted) { BS.mountSpace?.(h, { intensity: h.getAttribute('data-intensity') || 'hero' }); h.dataset.mounted = '1'; } } catch {} });
      document.querySelectorAll<HTMLElement>('[data-figure]').forEach((h) => { try { if (!h.dataset.drawn) { BS.diagrams?.render?.(h.dataset.figure!, h, {}); h.dataset.drawn = '1'; } } catch {} });
    };
    const t = setTimeout(run, 0);
    return () => clearTimeout(t);
  }, [path]);
  return null;
}
