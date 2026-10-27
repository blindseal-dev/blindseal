'use client';
import { useEffect, useRef, useState } from 'react';

// Phone width (< 720 px, ./narrow.css): the contents rail becomes a sticky "Contents" bar under the header;
// this button expands the section list beneath it. Hidden on desktop (display:none), where the rail is
// unchanged. The label follows the page's own scroll-spy (how-kit.tsx marks the current link
// .is-active) by watching the list's classes — nothing here writes outside the contents nav.
export function TocToggle() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  useEffect(() => {
    const btn = ref.current; const nav = btn?.closest('.hiw-toc'); const list = nav?.querySelector('.hiw-toc__list');
    if (!btn || !nav || !list) return;
    const read = () => {
      const a = list.querySelector('.hiw-toc__link.is-active');
      setCurrent(a ? Array.from(a.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '');
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // a section link closes the list (the page's own handler scrolls); Escape and a tap outside close it too
    const onList = (e: Event) => { if ((e.target as Element).closest('a')) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && nav.hasAttribute('data-open')) { setOpen(false); btn.focus(); } };
    const onDoc = (e: Event) => { if (!nav.contains(e.target as Node)) setOpen(false); };
    list.addEventListener('click', onList);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDoc);
    return () => { mo.disconnect(); list.removeEventListener('click', onList); document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDoc); };
  }, []);
  useEffect(() => {
    const nav = ref.current?.closest('.hiw-toc');
    if (!nav) return;
    if (open) nav.setAttribute('data-open', ''); else nav.removeAttribute('data-open');
  }, [open]);
  return (
    <button type="button" ref={ref} className="hiw-toc__toggle" data-hiw-toc-toggle="" aria-expanded={open} aria-controls="hiw-toc-rail" onClick={() => setOpen((v) => !v)}>
      <span className="hiw-toc__toggle-k">Contents</span>
      {current ? <span className="hiw-toc__toggle-v">{current}</span> : null}
      <svg className="hiw-toc__toggle-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}
