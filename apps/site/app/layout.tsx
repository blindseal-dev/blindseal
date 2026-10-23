import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { KitProvider } from './kit-provider';

export const metadata: Metadata = {
  title: 'Blindseal — prove an agent was screened',
  description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.',
};

// The kit, in the mockups' load order (S01/index.html): constants → icons → motion → reveal → glass
// → diagrams → ui → sheet → space → crt → site. fixtures.js is NOT loaded (no BS.data in the app).
const KIT = ['constants', 'icons', 'motion', 'reveal', 'glass', 'diagrams', 'ui', 'sheet', 'space', 'crt', 'site'];

// The chrome (frame, notch nav, footer) is rendered by BS.mountSite from KitProvider — the
// mockups' exact markup (wings, row, pill) — not hand-written here.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bs-js">
      <body>
        {KIT.map((k) => <Script key={k} src={`/kit/${k}.js`} strategy="beforeInteractive" />)}
        <main id="main-content" className="site-main">{children}</main>
        <KitProvider />
      </body>
    </html>
  );
}
