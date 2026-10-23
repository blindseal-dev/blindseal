import Link from 'next/link';
import type { ReactNode } from 'react';

// Prose inline markup → React (page.js's prose(): escaped text with `docs-ic` inline code). Deterministic,
// server-renderable: `code`, **strong**, *em*, [label](href).
const RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++} className="docs-ic">{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(mm[2].startsWith('/') ? <Link key={k++} className="link" href={mm[2]}>{mm[1]}</Link> : <a key={k++} className="link" href={mm[2]}>{mm[1]}</a>);
    }
    last = RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
