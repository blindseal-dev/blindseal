const PAGES: [string, string][] = [
  ['/docs', 'Quickstart'],
  ['/docs/concepts', 'Concepts'],
  ['/docs/hashing', 'Hashing spec'],
  ['/docs/integrate', 'Gated programs'],
  ['/docs/scope', 'What is proven'],
];

export function DocsNav({ current }: { current: string }) {
  return (
    <aside className="docs-nav">
      <nav aria-label="Docs">
        {PAGES.map(([href, label]) => (
          <a key={href} href={href} className="docs-nav__item" aria-current={href === current ? 'page' : undefined}>{label}</a>
        ))}
      </nav>
    </aside>
  );
}
