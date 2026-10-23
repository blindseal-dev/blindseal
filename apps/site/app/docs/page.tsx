import { DocsNav } from './nav';

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
  ['POST', '/api/attestations/:id/submit', 'Submit to Solana mainnet → tx signature.'],
  ['GET', '/api/nullifiers/:nullifier', 'On-chain status of a nullifier (mainnet, read server-side).'],
  ['GET', '/api/tee/quote', 'The L3 TEE quote (when L3 runs in a TEE).'],
  ['WS', '/events', 'Live stream: decision, status, policy, attestation frames.'],
];

export default function Docs() {
  return (
    <section className="site-section s04 docs-shell">
      <DocsNav current="/docs" />
      <div className="docs-body">
        <h1 className="section-head__title">Quickstart</h1>
        <p className="copy-text">Ten minutes on a fresh machine: install, run the proxy in front of an MCP server, see every tool call screened, and verify an attestation without trusting this site. Node 20+ and pnpm are the only requirements — the verifier ships as WebAssembly, so no Rust or Solana toolchain is needed to use Blindseal.</p>
        <section id="install"><h2 className="title-1">1. Install and run</h2>
          <pre className="code">{`$ git clone <repo> blindseal && cd blindseal
$ ./scripts/quickstart.sh          # installs, builds the dashboard, verifies the sample attestation
$ BLINDSEAL_MOCK=1 pnpm -C packages/proxy exec tsx src/index.ts run --mock
blindseal (MOCK): local API on http://127.0.0.1:7777
  dashboard: http://127.0.0.1:7777/#token=…`}</pre>
          <p className="copy-text">The proxy serves the dashboard from its own origin with a Content-Security-Policy that allows the WebAssembly verifier and nothing else. Open the printed URL — the token is in the fragment and never leaves memory.</p></section>
        <section id="agent"><h2 className="title-1">2. Point an agent</h2>
          <p className="copy-text">In the agent&apos;s MCP config, launch the upstream server through <code>blindseal</code>. Every tool call and result passes the four detection layers locally before it reaches the agent or the server.</p>
          <pre className="code">{`"mcpServers": {
  "github": { "command": "blindseal", "args": ["--", "github-mcp"] }
}`}</pre></section>
        <section id="attest"><h2 className="title-1">3. Attest a screened action</h2>
          <p className="copy-text">An attestation is a Groth16 proof that a specific tool call was screened under a committed policy by a specific detector version and that the deterministic layers passed. Proving runs locally on CPU and takes a while; it is asynchronous by design.</p>
          <pre className="code">{`$ blindseal attest call.json --target-program ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG --out attestation.json
decision d_…: clean (audit #12 0x…)
proving (this takes a while on CPU)…
attestation written: attestation.json`}</pre>
          <p className="copy-text">The decision is appended to the hash-chained audit log before proving starts, content-free: only ids, the verdict and the payload hash.</p></section>
        <section id="verify"><h2 className="title-1">4. Verify it — anywhere</h2>
          <pre className="code">{`$ blindseal verify attestation.json        # off-chain, the wasm verifier
$ blindseal submit attestation.json        # Solana mainnet: verifies on chain, consumes the nullifier
$ blindseal submit attestation.json --check   # has this nullifier been consumed?`}</pre>
          <p className="copy-text">Or drop the file on the <a href="/verify">verify page</a>: it runs the same verifier in your browser and uploads nothing. <code>submit</code> compares the RPC&apos;s genesis hash with mainnet-beta&apos;s before sending; there is no other cluster.</p></section>
        <section id="api"><h2 className="title-1">API reference</h2>
          <p className="copy-text">The local API the dashboard speaks. Auth: <code>Authorization: Bearer &lt;token&gt;</code>. Same-origin only; the browser never contacts an RPC — on-chain reads go through the proxy.</p>
          <table className="table docs-api"><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
            <tbody>{ENDPOINTS.map(([m, p, d]) => <tr key={p}><td><span className="chip outline">{m}</span></td><td className="mono">{p}</td><td className="is-muted">{d}</td></tr>)}</tbody></table></section>
      </div>
    </section>
  );
}
