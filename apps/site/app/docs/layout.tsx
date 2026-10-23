import './docs.css';
import { DocsSide } from './side';

// S04's frame: the three-column .docs grid (sidebar tree · the page stage · the on-this-page rail). The
// sidebar is the layout's; each route renders the stage and the rail (render.tsx) as the grid's other
// two children, so the tree and its search survive page changes.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs" data-docs>
      <DocsSide />
      {children}
    </div>
  );
}
