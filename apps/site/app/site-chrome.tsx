// The site chrome, rendered by React on the SERVER from the same templates the kit knows
// (kit/site-templates.cjs, extracted verbatim from site.js), so the markup is the mockups' and the kit
// only adopts it: BS.mountSite finds these nodes, wires the sliding white pill, setActive, the hero spaces and
// the rise — it creates nothing in html/head/body. The active item is set by the kit on the client (the
// layout has no pathname on the server).
// Round 2: navHtml renders the glass pill — the tri-lobe render and the wordmark on the left, the five route
// links in the middle, X and GitHub icon buttons (new tab, rel noopener) on the right, and nothing else. There
// is no footer: its npm and Home links stay out on purpose (the mark goes home; npm is linked from Docs).
import { createRequire } from 'node:module';
import { ROUTES } from './routes';
import { SiteMenu } from './site-menu';
const req = createRequire(import.meta.url);
const tpl = req('../kit/site-templates.cjs') as { navHtml: (c: unknown) => string };

const CTX = { routes: ROUTES, brand: 'Blindseal', social: { x: 'https://x.com/blindsealtech', github: 'https://github.com/blindseal-dev/blindseal' } };

export function SiteChromeTop() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="site-frame" aria-hidden="true" />
      <header className="site-notch" data-site-nav-root="" dangerouslySetInnerHTML={{ __html: tpl.navHtml(CTX) }} />
      {/* wires the phone menu rendered inside the header above; renders nothing */}
      <SiteMenu />
    </>
  );
}
