import Link from 'next/link';
import type { Metadata } from 'next';
import { BUCKET_OF, BY_SLUG, targetsOf, type Block, type DocPage, type DocSection, type Endpoint } from './content';
import { CodeBlock } from './code';
import { inline } from './inline';
import { DocsBehaviour } from './behaviour';
import { pageMeta, ONE_LINER } from '../meta';

// page.js's render(slug): the masthead, the numbered sections (.docs-sec[data-target] with the anchor
// button), prev / next, and the "On this page" rail — the same markup, server-rendered from content.ts so
// the page reads without JS. behaviour.tsx adds the spy, the fill, the anchors and the transitions.
const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

function AnchorBtn({ id, label }: { id: string; label: string }) {
  return <button type="button" className="docs-anchor" data-anchor={id} aria-label={`Copy a link to ${label}`}><i data-lucide="link" /></button>;
}

function pathNodes(path: string) {
  // ":param" segments in the accent (page.js pathHtml)
  return path.split(/(:[a-z]+)/i).map((part, i) => (part.startsWith(':') ? <i key={i}>{part}</i> : part));
}

function ApiTable({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <div className="table-box docs-api">
      <table className="table">
        <thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Description</th></tr></thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={`${e.method} ${e.path}`} data-api-ep={`${e.method} ${e.path}`}>
              <td className="is-mono"><span className="api-m" data-m={e.method}>{e.method}</span></td>
              <td className="is-mono"><span className="api-ep__path">{pathNodes(e.path)}</span></td>
              <td className="is-note">{e.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'p': return <p className="docs-p">{inline(b.text)}</p>;
    case 'code': return <CodeBlock text={b.text} lang={b.lang} />;
    case 'list': {
      const items = b.items.map((t, i) => <li key={i} className="docs-p">{inline(t)}</li>);
      return b.ordered ? <ol className="docs-list">{items}</ol> : <ul className="docs-list">{items}</ul>;
    }
    case 'callout': return <div className={`callout${b.muted ? ' muted' : ''}`}><p className="callout__title">{b.title}</p><p className="callout__body">{inline(b.body)}</p></div>;
    case 'links': return (
      <div className="docs-links">
        {b.links.map((l) => l.external
          ? <a key={l.href} className="docs-link" href={l.href} target="_blank" rel="noopener">{l.label}<i data-lucide={l.icon ?? 'arrow-up-right'} /></a>
          : <Link key={l.href} className="docs-link" href={l.href}>{l.label}<i data-lucide={l.icon ?? 'arrow-right'} /></Link>)}
      </div>
    );
    case 'api': return <ApiTable endpoints={b.endpoints} />;
  }
}

function Section({ s, n }: { s: DocSection; n: number }) {
  return (
    <section className="docs-sec reveal" id={s.id} data-target data-label={s.heading}>
      <div className="docs-sec__head">
        <p className="docs-sec__n"><b>{pad2(n)}</b>{s.count ? ` / ${s.count}` : ''}</p>
        <h2 className="docs-h2">{s.heading}<AnchorBtn id={s.id} label={s.heading} /></h2>
      </div>
      {s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
    </section>
  );
}

function PrevNext({ pg }: { pg: DocPage }) {
  const prev = pg.prev ? BY_SLUG[pg.prev] : undefined, next = pg.next ? BY_SLUG[pg.next] : undefined;
  return (
    <nav className="docs-pn" aria-label="Previous and next page">
      {prev ? <Link className="docs-pn__card" href={prev.path} rel="prev"><span className="docs-pn__k"><i data-lucide="chevron-left" />Previous</span><span className="docs-pn__t">{prev.title}</span><span className="docs-pn__g">{BUCKET_OF[prev.slug]}</span></Link>
            : <p className="docs-pn__start">You are on the first page.</p>}
      {next ? <Link className="docs-pn__card docs-pn__card--next" href={next.path} rel="next"><span className="docs-pn__k">Next<i data-lucide="chevron-right" /></span><span className="docs-pn__t">{next.title}</span><span className="docs-pn__g">{BUCKET_OF[next.slug]}</span></Link>
            : <p className="docs-pn__end">End of the docs.</p>}
    </nav>
  );
}

/** Prose markup → plain text for meta tags: `[text](url)` → text, then backticks and asterisks dropped. */
export function plainText(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*]/g, '');
}

export function docMetadata(slug: string): Metadata {
  const pg = BY_SLUG[slug];
  // per-page meta description = the page summary as plain text; the shared OG text for every docs page = the tagline
  return pageMeta({ path: pg.path, title: `${pg.title} · Docs · Blindseal`, description: plainText(pg.summary), ogDescription: ONE_LINER });
}

export function DocRoute({ slug }: { slug: string }) {
  const pg = BY_SLUG[slug];
  const targets = targetsOf(pg);
  return (
    <>
      <div className="docs-main">
        <div className="docs-stage" data-stage>
          <article className="docs-page" data-doc aria-live="polite">
            <header className="docs-mast">
              <p className="docs-crumb"><span>Docs</span><span aria-hidden="true">/</span><span>{BUCKET_OF[pg.slug]}</span></p>
              <h1 className="docs-title" id="docs-title">{pg.title}</h1>
              <p className="docs-summary">{inline(pg.summary)}</p>
            </header>
            {pg.sections.map((s, i) => <Section key={s.id} s={s} n={i + 1} />)}
            <PrevNext pg={pg} />
          </article>
        </div>
      </div>

      <aside className="docs-otp-col" aria-label="On this page">
        <nav className="docs-otp" data-otp>
          <p className="docs-otp__head">On this page</p>
          <div className="docs-otp__rail">
            <div className="docs-otp__track" aria-hidden="true"><span className="docs-otp__fill" data-fill /></div>
            <ol className="docs-otp__list" data-otp-list>
              {targets.map((t) => <li key={t.id}><a className={`docs-otp__link${t.level === 2 ? ' is-sub' : ''}`} href={`#${t.id}`} data-otp={t.id}>{t.label}</a></li>)}
            </ol>
          </div>
          <button type="button" className="docs-otp__top" data-top disabled><i data-lucide="chevron-up" />Back to top</button>
        </nav>
      </aside>
      <DocsBehaviour />
    </>
  );
}
