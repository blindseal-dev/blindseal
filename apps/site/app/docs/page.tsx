const ENDPOINTS = [
  ['GET', '/api/status', 'Proxy status: connection, policy root, detector version, audit head, L3 mode.'],
  ['GET', '/api/decisions', 'List decisions; filters verdict/server/tool/from/to, cursor pagination.'],
  ['GET', '/api/decisions/:id', 'One decision with all layer results and commitments.'],
  ['POST', '/api/decisions/:id/reveal', 'Reveal the raw payload (requires X-Confirm: reveal). Never stored.'],
  ['GET', '/api/audit/head', 'The current hash-chain head.'],
  ['GET', '/api/audit/entries', 'Content-free entries in a range (from/to).'],
  ['POST', '/api/audit/verify', 'Recompute the chain from genesis → { ok, brokenAt? }.'],
  ['POST', '/api/audit/disclose', 'Signed disclosure for a range { from, to }.'],
  ['GET', '/api/policy', 'The committed policy: root, version, leaf count, rules.'],
  ['PUT', '/api/policy', 'Replace rules; the proxy recomputes the Merkle root.'],
  ['POST', '/api/policy/dry-run', 'Screen a payload without logging or chaining it.'],
  ['GET', '/api/attestations', 'List attestations; filter by status.'],
  ['POST', '/api/attestations', 'Request an attestation for a decision with an action.'],
  ['POST', '/api/attestations/:id/submit', 'Submit to a cluster → tx signature.'],
  ['GET', '/api/tee/quote', 'The L3 TEE quote (when L3 runs in a TEE).'],
  ['WS', '/events', 'Live stream: decision, status, policy, attestation frames.'],
];
const NAV = [['start', 'Getting started'], ['agent', 'Point an agent'], ['api', 'API reference']];
export default function Docs() {
  return (
    <section className="site-section s04 docs-shell">
      <aside className="docs-nav"><nav aria-label="Docs">{NAV.map(([id, l]) => <a key={id} href={`#${id}`} className="docs-nav__item">{l}</a>)}</nav></aside>
      <div className="docs-body">
        <h1 className="section-head__title">Docs</h1>
        <section id="start"><h2 className="title-1">Getting started</h2>
          <p className="copy-text">Install the proxy and point an agent at it. Every tool call is screened locally before it runs.</p>
          <pre className="code">$ npx @blindseal/proxy init
$ BLINDSEAL_MOCK=1 blindseal run   # try it with fixtures</pre></section>
        <section id="agent"><h2 className="title-1">Point an agent</h2>
          <p className="copy-text">In the agent&apos;s MCP config, launch the upstream server with <code>blindseal run</code> in front of it:</p>
          <pre className="code">{`"mcpServers": {
  "github": { "command": "blindseal", "args": ["run", "--upstream", "github-mcp"] }
}`}</pre></section>
        <section id="api"><h2 className="title-1">API reference</h2>
          <p className="copy-text">The local API the dashboard speaks (FRONTEND §5). Auth: <code>Authorization: Bearer &lt;token&gt;</code>.</p>
          <table className="table docs-api"><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
            <tbody>{ENDPOINTS.map(([m, p, d]) => <tr key={p}><td><span className="chip outline">{m}</span></td><td className="mono">{p}</td><td className="is-muted">{d}</td></tr>)}</tbody></table></section>
      </div>
    </section>
  );
}
