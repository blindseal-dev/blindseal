'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Rendered at the END of every page's tree. Its effect can only run once React has hydrated (or
// client-rendered) the page segment it sits in — the root layout's own boundary hydrates earlier, so
// an effect there (KitProvider) would fire while the page may still be hydrating under selective
// hydration. KitProvider waits for this signal for the current path before the kit touches the DOM.
export function PageHydrated() {
  const path = usePathname();
  useEffect(() => {
    (window as unknown as { __bsPageHydrated?: string }).__bsPageHydrated = path;   // no DOM write: the pre/post hydration diff must stay empty
    window.dispatchEvent(new CustomEvent('bs:page-hydrated', { detail: { path } }));
  }, [path]);
  return null;
}
