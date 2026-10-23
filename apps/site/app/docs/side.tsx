'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LATEST, TREE } from './content';

// The sidebar: the search (page.js's slot, here a real filter over the tree with the `/` shortcut and
// Escape to clear), the tree (aria-current from the pathname) and the latest-release footer. It lives in
// the docs layout, so it persists across page navigations. Items are hidden, never unmounted, so the
// kit-swapped icons above them are never touched by React.
export function DocsSide() {
  const path = usePathname();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const groups = TREE.map((g) => ({ ...g, items: g.items.map((it) => ({ ...it, hit: !needle || it.keywords.includes(needle) })) }));
  const any = groups.some((g) => g.items.some((it) => it.hit));

  return (
    <aside className="docs-side" aria-label="Documentation">
      <div className="docs-side__in">
        <div className="docs-search">
          <label className="sr-only" htmlFor="docs-search">Search the docs</label>
          <div className="input-group has-end">
            <i data-lucide="search" />
            <input ref={input} className="input docs-search__input" id="docs-search" type="search" placeholder="Search the docs" autoComplete="off" spellCheck={false}
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur(); } if (e.key === 'Enter') e.preventDefault(); }} />
            <span className="input-group__end"><kbd className="kbd" aria-hidden="true">/</kbd></span>
          </div>
        </div>
        <nav className="docs-tree" aria-label="Docs pages" data-tree>
          {groups.map((g) => (
            <div key={g.group} className="docs-tree__group" hidden={!g.items.some((it) => it.hit)}>
              <p className="docs-tree__head">{g.group}</p>
              {g.items.map((it) => (
                <Link key={it.slug} className="docs-tree__item" href={it.path} data-page={it.slug} hidden={!it.hit} aria-current={path === it.path ? 'page' : undefined}>
                  <span className="docs-tree__dot" aria-hidden="true" /><span>{it.title}</span>
                </Link>
              ))}
            </div>
          ))}
          {!any && <p className="docs-side__sub" role="status">No page mentions “{q.trim()}”.</p>}
        </nav>
        <div className="docs-side__foot" data-side-foot>
          <p className="docs-side__k">Latest release</p>
          <p className="docs-side__v">proxy {LATEST.version}<span className="chip outline">{LATEST.dateLabel}</span></p>
          <p className="docs-side__sub">The docs track the latest proxy release.</p>
          <Link className="docs-link" href={LATEST.href}>Changelog<i data-lucide="arrow-up-right" /></Link>
        </div>
      </div>
    </aside>
  );
}
