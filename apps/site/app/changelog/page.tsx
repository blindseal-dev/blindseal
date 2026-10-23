const RELEASES = [
  { v: '0.5.0', date: '2026-10-23', added: ['On-chain verifier program (blindseal-verify) and the transfer-gate example: Groth16 verify via sp1-solana, nullifier set, vkey and policy-root allowlists, paused flag', 'SDK: buildVerifyIx, submit (mainnet-only, genesis-hash guarded), verifyOffchain', 'CLI: blindseal attest (screen → audit → prove) and blindseal submit', 'The proxy serves the built dashboard with application/wasm and a CSP that allows the in-browser verifier', 'Mainnet explorer and on-chain nullifier status, read server-side'], changed: ['Solana mainnet is the only deploy target; chainId 2 is reserved (devnet removed everywhere)', 'The verify pages run the real Groth16 verifier compiled to WebAssembly; the mock verifier is gone', 'Attestations carry the action fields and nonce the on-chain recompute needs'], fixed: ['Attestation detail decodes the single committed public-input blob into its six fields'] },
  { v: '0.4.0', date: '2026-10-22', added: ['Local dashboard (decisions, audit, policy, attestations, settings)', 'Verify page with the in-browser verifier'], changed: ['Policy root is now a Merkle over the committed rule DFAs'], fixed: ['HTML-entity decoder no longer fails open on oversized entities'] },
  { v: '0.3.0', date: '2026-10-10', added: ['Off-chain Groth16 verifier (sp1-verifier)', 'Hash-chained audit log with selective disclosure'], changed: ['Detector version is the SP1 vkey'], fixed: [] },
  { v: '0.2.0', date: '2026-09-20', added: ['SP1 guest: payloadHash + policyRoot commitment', 'Redaction before L2/L3'], changed: [], fixed: [] },
];
export default function Changelog() {
  return (
    <section className="site-section s06">
      <div className="section-head"><div className="section-head__lead"><p className="section-head__eyebrow"><b>·</b> / Changelog</p><h1 className="section-head__title">Changelog</h1></div>
        <p className="section-head__body">Dated releases. Versions follow the proxy.</p></div>
      <nav className="s06-rail" aria-label="Versions">{RELEASES.map((r) => <a key={r.v} href={`#v${r.v}`} className="s06-rail__v">v{r.v}</a>)}</nav>
      <div className="s06-list">
        {RELEASES.map((r) => (
          <article key={r.v} className="site-panel s06-rel" id={`v${r.v}`}>
            <header className="s06-rel__head"><h2 className="panel__title">v{r.v}</h2><span className="is-faint mono">{r.date}</span></header>
            {(['added', 'changed', 'fixed'] as const).map((k) => (r as any)[k].length ? (
              <div key={k} className="s06-group"><p className="eyebrow">{k}</p><ul>{(r as any)[k].map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
            ) : null)}
          </article>
        ))}
      </div>
    </section>
  );
}
