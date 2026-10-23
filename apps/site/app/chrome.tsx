import Link from 'next/link';

const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/verify', label: 'Verify' },
  { href: '/docs', label: 'Docs' },
  { href: '/explorer', label: 'Explorer' },
  { href: '/changelog', label: 'Changelog' },
];

export function SiteNav() {
  return (
    <header className="site-notch" role="banner">
      <nav className="notch" aria-label="Primary">
        <Link href="/" className="notch__brand" aria-label="Blindseal home">
          <span className="notch__seal" aria-hidden />
          <span className="notch__word">Blindseal</span>
        </Link>
        <div className="notch__links">
          {NAV.map((n) => <Link key={n.href} href={n.href} className="notch__item" data-label={n.label}>{n.label}</Link>)}
        </div>
        <Link href="/docs" className="btn primary notch__action">Open dashboard</Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__row">
        <span className="site-footer__brand">Blindseal</span>
        <span className="site-footer__tag">Prove an agent&apos;s action was screened — without showing what it was.</span>
      </div>
      <div className="site-footer__meta">
        <span className="mono">127.0.0.1:7777</span>
        <span>· local-only · zero external requests</span>
      </div>
    </footer>
  );
}
