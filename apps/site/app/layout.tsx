import type { Metadata } from 'next';
import './globals.css';
import { KitProvider } from './kit-provider';

export const metadata: Metadata = {
  title: 'Blindseal — prove an agent was screened',
  description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.',
};

// The kit (one ordered bundle, public/kit/kit.js, built by scripts/bundle-kit.mjs in the mockups'
// load order) is loaded AFTER hydration by KitProvider: icons/glass/diagrams/ui boot on
// DOMContentLoaded and rewrite the DOM, which would otherwise race React's hydration (#418/#423).
// The chrome (frame, notch nav, footer) is rendered by BS.mountSite — the mockups' exact markup
// (wings, row, pill) — not hand-written here. fixtures.js is never loaded (no BS.data in the app).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bs-js">
      <body>
        <main id="main-content" className="site-main">{children}</main>
        <KitProvider />
      </body>
    </html>
  );
}
