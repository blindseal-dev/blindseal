import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { KitBoot } from './kit-boot';
import { SiteNav, SiteFooter } from './chrome';

export const metadata: Metadata = {
  title: 'Blindseal — prove an agent was screened',
  description: 'A privacy-preserving, verifiable screening layer for AI agents. Nothing sensitive leaves the machine.',
};

const KIT = ['constants', 'icons', 'motion', 'reveal', 'glass', 'diagrams', 'sheet', 'space', 'ui'];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bs-js">
      <body>
        {KIT.map((k) => <Script key={k} src={`/kit/${k}.js`} strategy="beforeInteractive" />)}
        <SiteNav />
        <main id="main-content">{children}</main>
        <SiteFooter />
        <KitBoot />
      </body>
    </html>
  );
}
