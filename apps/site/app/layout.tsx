import type { Metadata } from 'next';
import './globals.css';
import { KitProvider } from './kit-provider';
import { GlassDefs } from './glass-defs';
import { SiteChromeTop } from './site-chrome';
import { SITE_URL, SITE_NAME, ONE_LINER, OG_IMAGE } from './meta';

// Site-wide defaults only: each page sets its own canonical, og: and twitter: tags through pageMeta (meta.ts).
// The favicon is app/icon.svg (+ app/favicon.ico, app/apple-icon.png): the flat tri-lobe, the mark icons.js draws (round 2).
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  openGraph: { type: 'website', siteName: SITE_NAME, title: 'Blindseal — prove an agent was screened', description: ONE_LINER, images: [OG_IMAGE] },
  twitter: { card: 'summary_large_image', title: 'Blindseal — prove an agent was screened', description: ONE_LINER, images: [OG_IMAGE] },
  title: 'Blindseal — prove an agent was screened',
  description: ONE_LINER,
};

// The kit (one ordered bundle, public/kit/kit.js, built by scripts/bundle-kit.mjs in the mockups' load
// order) is injected AFTER hydration by KitProvider and does nothing at load. The chrome — skip-link,
// frame, the glass pill nav — is rendered HERE on the server from the kit's own templates
// (kit/site-templates.cjs); BS.mountSite only adopts it (the kit creates nothing and
// writes nothing on <html>, <head> or body children, so hydration cannot race it). fixtures.js is never
// loaded (no BS.data in the app). There is no footer (round 2): each page ends on its last section.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bs-js bs-site">
      <body>
        <SiteChromeTop />
        <GlassDefs />
        <main id="main-content" className="site-main">{children}</main>
        <KitProvider />
      </body>
    </html>
  );
}
