// Placeholder for the dashboard pages still to be ported from frontend-reference/ (Audit, Policy,
// Attestations, Settings). The shell, routing, design tokens and data layer are in place; each
// page is a mechanical port of its mockup against the hooks in src/api/hooks.ts.
export function Stub({ title, note }: { title: string; note: string }) {
  return (
    <div className="bs-panel bs-stub">
      <h2>{title}</h2>
      <p>{note}</p>
      <p className="bs-faint">
        Reference mockup: <code>frontend-reference/mockups/</code>. Wire it to the data layer in{' '}
        <code>src/api/hooks.ts</code>.
      </p>
    </div>
  );
}
