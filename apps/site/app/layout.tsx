import type { Metadata } from 'next';
import './globals.css';
import { KitProvider } from './kit-provider';
import { GlassDefs } from './glass-defs';
import { SiteChromeTop, SiteFooter } from './site-chrome';

export const metadata: Metadata = {
  metadataBase: new URL('https://blindseal.tech'),
  alternates: { canonical: '/' },
  openGraph: { type: 'website', url: 'https://blindseal.tech', siteName: 'Blindseal', title: 'Blindseal — prove an agent was screened', description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.' },
  twitter: { card: 'summary', title: 'Blindseal — prove an agent was screened', description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.' },
  title: 'Blindseal — prove an agent was screened',
  description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.',
  // the favicon icons.js used to inject (same SVG, the tokens' --canvas / --ink values)
  icons: { icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2064%2064%27%3E%3Crect%20width%3D%2764%27%20height%3D%2764%27%20rx%3D%2716%27%20fill%3D%27%23060510%27%2F%3E%3Ccircle%20cx%3D%2732%27%20cy%3D%2732%27%20r%3D%2719%27%20fill%3D%27none%27%20stroke%3D%27%23f7f7f7%27%20stroke-width%3D%274%27%2F%3E%3Crect%20x%3D%2722%27%20y%3D%2729%27%20width%3D%2720%27%20height%3D%276%27%20rx%3D%273%27%20fill%3D%27none%27%20stroke%3D%27%23f7f7f7%27%20stroke-width%3D%273.5%27%2F%3E%3C%2Fsvg%3E' },
};

// The kit (one ordered bundle, public/kit/kit.js, built by scripts/bundle-kit.mjs in the mockups' load
// order) is injected AFTER hydration by KitProvider and does nothing at load. The chrome — skip-link,
// frame, notch, footer — is rendered HERE on the server from the kit's own templates
// (kit/site-templates.cjs); BS.mountSite only adopts it (DECISIONS 2026-10-23: the kit creates nothing and
// writes nothing on <html>, <head> or body children, so hydration cannot race it). fixtures.js is never
// loaded (no BS.data in the app).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bs-js bs-site">
      <body>
        <SiteChromeTop />
        <GlassDefs />
        <main id="main-content" className="site-main">{children}<SiteFooter /></main>
        <KitProvider />
      </body>
    </html>
  );
}
