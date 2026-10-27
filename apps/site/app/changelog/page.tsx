import type { Metadata } from 'next';
import { pageMeta } from '../meta';
import type { ReactNode } from 'react';
import { ChangelogKit, type Entry } from './changelog-kit';
import { RELEASES } from './releases';
import './changelog.css';

export const metadata: Metadata = pageMeta({
  path: '/changelog',
  title: 'Changelog · Blindseal',
  description: 'Dated release notes for the proxy, the dashboard and the site.',
});

// S06 — Changelog (/changelog), dated release notes: the mockup's masthead band over the faint
// field, a sticky version rail (scroll-spy, the latest with the accent dot) and one flat panel per
// release, newest first, grouped Added · Changed · Fixed. The mockup rendered BS.data.changelog in
// page.js; the site never loads the fixtures, so the releases live here and are server-rendered —
// the rail and every entry are static HTML, and changelog-kit.tsx (the page.js port) adds the spy,
// the reveals, the "#" copy links and the deep links after the kit mounts.

type Release = { version: string; component: string; date: string; id: string; added: string[]; changed: string[]; fixed: string[] };
const GROUPS = [['added', 'Added'], ['changed', 'Changed'], ['fixed', 'Fixed']] as const;

// page.js's id scheme: the newest release of a version owns the bare id (#v0.4.0); a later release
// with the same number takes #v<version>-<component>. Every entry also answers to the long form.
function buildLog(): Release[] {
  const seen = new Set<string>();
  return RELEASES.map((r) => {
    const component = 'proxy';
    const bare = 'v' + r.v;
    const id = seen.has(bare) ? bare + '-' + component : bare;
    seen.add(bare);
    return { version: r.v, component, date: r.date, id, added: r.added, changed: r.changed, fixed: r.fixed };
  });
}

// The kit's fmt.date style ("Oct 20, 2026") from the ISO day, computed on the server from the string
// alone: no Date, no locale, no time zone, so the markup hydrates identically everywhere.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLong(ymd: string) { const [y, m, d] = ymd.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; }
function dayShort(ymd: string) { return dayLong(ymd).replace(/,\s*\d{4}$/, ''); }

// identifiers in the notes read as code: env assignments, routes, method + path, camelCase names,
// detector versions (page.js's CODE_RE, applied to the text itself — JSX escapes the rest), and `backticks`
const CODE_RE = /`[^`]+`|\b(?:GET|POST|PUT|DELETE) \/[\w/.:-]+|\b[A-Z][A-Z0-9_]{2,}=\w+|(?:^|(?<=\s))\/[a-z][\w/-]*|\bdet-\d{4}\.\d+\.\d+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
function codeSpans(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0;
  for (const m of text.matchAll(CODE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    out.push(<code key={key + at}>{t.startsWith('`') ? t.slice(1, -1) : t}</code>);
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
// {{id:…}} / {{sig:…}}: BS.ui.hash's markup (4 + 4 shown, the full value in data-hash, the title and the
// accessible name), so a 88-character signature never breaks the layout; the kit's .hash delegation
// adds copy-on-click and the full-value tooltip once it mounts.
const REF_RE = /\{\{(id|sig):([1-9A-HJ-NP-Za-km-z]+)\}\}/g;
function Ref({ kind, value }: { kind: 'id' | 'sig'; value: string }) {
  const label = kind === 'id' ? 'Program id' : 'Transaction signature';
  return (
    <button type="button" className="hash cl-ref" data-hash={value} data-label={label} title={value} aria-label={`${label} ${value}. Copy`}>
      <span className="hash__v">{value.slice(0, 4) + '…' + value.slice(-4)}</span>
    </button>
  );
}
function note(text: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0;
  for (const m of text.matchAll(REF_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(...codeSpans(text.slice(last, at), 't' + last));
    out.push(<Ref key={'r' + at} kind={m[1] as 'id' | 'sig'} value={m[2]!} />);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(...codeSpans(text.slice(last), 't' + last));
  return out;
}

export default function Changelog() {
  const LOG = buildLog();
  const entries: Entry[] = LOG.map((e) => ({ id: e.id, version: e.version, component: e.component, date: e.date }));
  return (
    <>
      {/* masthead: the S03 / S05 band (flat panel over the faint nebula), 260 high */}
      <header className="cl-mast" aria-labelledby="cl-title">
        <div className="cl-mast__space" aria-hidden="true" />
        <div className="cl-mast__copy">
          <p className="cl-mast__eyebrow">Changelog</p>
          <h1 className="cl-mast__title" id="cl-title">Releases.</h1>
          <p className="cl-mast__lede">Proxy, dashboard and site, dated. A release that changes a claim’s wording or a program id says so.</p>
        </div>
      </header>

      {/* body: version rail + entries */}
      <div className="cl" id="cl">
        <aside className="cl-rail-col">
          <nav className="cl-rail" aria-label="Versions">
            <p className="cl-rail__head">Versions</p>
            <div className="cl-rail__body">
              <div className="cl-rail__track" aria-hidden="true"><span className="cl-rail__fill" /></div>
              <ol className="cl-rail__list" id="cl-rail-list">
                {LOG.map((e, i) => (
                  <li key={e.id}>
                    <a className="cl-rail__link" href={'#' + e.id} data-rail={e.id}>
                      {i === 0 && <span className="cl-rail__dot" aria-hidden="true" />}
                      <span className="cl-rail__v">v{e.version} · {dayShort(e.date)}</span>
                      <span className="cl-rail__c">{e.component}</span>
                      {i === 0 && <span className="sr-only">, latest</span>}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
            <button type="button" className="cl-rail__top" data-top disabled><i data-lucide="chevron-up" />Back to top</button>
          </nav>
        </aside>

        <section className="cl-entries" id="cl-entries" aria-label="Releases, newest first">
          {LOG.map((e, i) => (
            <article key={e.id} className="cl-entry" id={e.id} data-i={i} data-component={e.component} aria-labelledby={e.id + '-h'}>
              <header className="cl-entry__head">
                <h2 className="cl-entry__v" id={e.id + '-h'}>v{e.version}<span className="sr-only">, {e.component}</span></h2>
                <time className="cl-entry__date" dateTime={e.date}>{dayLong(e.date)}</time>
                <span className="cl-entry__chips">
                  <span className="chip neutral">{e.component}</span>
                  {i === 0 && <span className="chip accent">latest</span>}
                </span>
                {/* the copy text is the path-relative anchor until the kit mounts; changelog-kit.tsx sets the absolute URL */}
                <button type="button" className="cl-anchor" data-copy={'#' + e.id} data-anchor={e.id}>
                  <span aria-hidden="true">#</span><span className="sr-only">Copy link to v{e.version} {e.component}</span>
                </button>
              </header>
              <div className="cl-entry__groups">
                {GROUPS.filter(([k]) => e[k].length).map(([k, label]) => (
                  <section key={k} className="cl-group" aria-label={label}>
                    <h3 className="cl-group__k">{label}</h3>
                    <ul className="cl-group__list">{e[k].map((t, n) => <li key={n}>{note(t)}</li>)}</ul>
                  </section>
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>

      <ChangelogKit entries={entries} />
    </>
  );
}
