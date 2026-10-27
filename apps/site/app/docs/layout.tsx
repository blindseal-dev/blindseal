import './docs.css';
import { DocsSide } from './side';
import { PROXY_VERSION, PROXY_RELEASE_DATE } from '../version';

// S04's frame: the three-column .docs grid (sidebar tree · the page stage · the on-this-page rail). The
// sidebar is the layout's; each route renders the stage and the rail (render.tsx) as the grid's other
// two children, so the tree and its search survive page changes.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs" data-docs>
      {/* the latest release, read at build time from packages/proxy/package.json (no hard-coded version) */}
      <DocsSide latest={{ version: PROXY_VERSION, dateLabel: PROXY_RELEASE_DATE }} />
      {children}
    </div>
  );
}
