// The site chrome, rendered by React on the SERVER from the same templates the kit knows
// (kit/site-templates.cjs, extracted verbatim from site.js), so the markup is the mockups' and the kit
// only adopts it: BS.mountSite finds these nodes, wires the sliding pill, setActive, the hero spaces and
// the rise — it creates nothing in html/head/body (DECISIONS 2026-10-23). The active item and the
// footer's aria-current are set by the kit on the client (the layout has no pathname on the server).
import { createRequire } from 'node:module';
import { DASHBOARD_URL, ROUTES } from './routes';
const req = createRequire(import.meta.url);
const tpl = req('../kit/site-templates.cjs') as { navHtml: (c: unknown) => string; footerHtml: (c: unknown) => string };

export const SITE_VERSION = '0.5.0';
const CTX = { routes: ROUTES, brand: 'Blindseal', action: { label: 'Open dashboard', href: DASHBOARD_URL }, oneLiner: "Prove an agent's action was screened — without showing what it was.", version: SITE_VERSION };

export function SiteChromeTop() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="site-frame" aria-hidden="true" />
      <header className="site-notch" data-site-nav-root="" dangerouslySetInnerHTML={{ __html: tpl.navHtml(CTX) }} />
    </>
  );
}
export function SiteFooter() {
  return <footer className="site-footer" aria-label="Site footer" dangerouslySetInnerHTML={{ __html: tpl.footerHtml(CTX) }} />;
}
