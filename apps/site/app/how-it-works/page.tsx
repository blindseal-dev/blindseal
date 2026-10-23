const SECTIONS = [
  ['01', 'The local proxy', 'Blindseal sits between an agent and its tools as a local proxy, inspecting every tool call before it executes. Nothing sensitive leaves the machine.', null],
  ['02', 'Four detection layers', 'L0 decodes hidden text and re-runs L1; L1 is a set of committed regex/heuristic rules; L2 is embeddings; L3 is an LLM judge. Only L0 and L1 are proven in zero-knowledge; L2 and L3 are attested, not proven.', 'layers'],
  ['03', 'The architecture', 'The proxy screens, redacts secrets before the model-based layers see them, writes a hash-chained audit entry, and — on demand — produces a zero-knowledge attestation.', 'architecture'],
  ['04', 'Redaction before the judge', 'Secrets and PII are redacted before L2/L3 run, so the judge (local or in a TEE) never sees them. The redacted hash is committed alongside the payload hash.', null],
  ['05', 'The attestation lifecycle', 'A proof is generated locally, submitted to a consumer program, consumed once, and then expires. It binds to the action, so it is worthless for any other call.', 'lifecycle'],
  ['06', 'Action binding', 'Target program, source authority, recipient, amount, policy root, detector version and expiry are hashed into the attestation. Single-use via a nullifier.', null],
  ['07', 'Verified on Solana', 'The Groth16 proof verifies in one Solana instruction (sp1-solana). Any program can gate agent actions without seeing the prompt, the arguments, the rules, or which agent was screened.', null],
  ['08', 'The audit chain', 'Every decision is written to a hash-chained local log. Prove a window was clean, or that one event occurred, without exposing traffic.', 'chain'],
];
export default function How() {
  return (
    <section className="site-section s02">
      <aside className="s02-rail"><nav aria-label="Contents">{SECTIONS.map(([n, t]) => <a key={n} href={`#s${n}`} className="s02-rail__item"><b>{n}</b> {t}</a>)}</nav></aside>
      <div className="s02-body">
        <div className="section-head"><div className="section-head__lead"><p className="section-head__eyebrow"><b>·</b> / How it works</p><h1 className="section-head__title">Screen, attest, prove, verify.</h1></div>
          <p className="section-head__body">The long version. The claim is deliberately narrow: this call was screened under policy R by detector version V — not a blanket guarantee about the agent.</p></div>
        {SECTIONS.map(([n, t, body, fig]) => (
          <section key={n} id={`s${n}`} className="s02-sec reveal">
            <h2 className="title-1"><span className="s02-sec__n">{n}</span> {t}</h2>
            <p className="copy-text">{body}</p>
            {fig && <figure className="fig s02-fig" data-figure={fig} aria-label={`${t} figure`} />}
          </section>
        ))}
      </div>
    </section>
  );
}
