import { DocsNav } from '../nav';

export default function Scope() {
  return (
    <section className="site-section s04 docs-shell">
      <DocsNav current="/docs/scope" />
      <div className="docs-body">
        <h1 className="section-head__title">What is proven — and what is not</h1>
        <p className="copy-text">Blindseal proves that a specific call was screened under a committed policy by a specific detector version, and that the deterministic layers passed. The model-based layers run locally or in a TEE and are attested, not proven. Blindseal does not prove an agent is safe, and does not cover traffic that doesn&apos;t pass through the proxy.</p>

        <section id="proven"><h2 className="title-1">Proven (zero-knowledge, verifiable by anyone)</h2>
          <ul className="copy-text">
            <li>The payload with this hash was screened by the detector with this verifying key, under the policy with this root.</li>
            <li>The deterministic layer (L1 regex rules, as committed DFAs) found it clean. A proof cannot exist for a payload L1 flags.</li>
            <li>The screening is bound to one on-chain action — program, instruction, signer, recipient, mint, amount — and to an expiry slot and a fresh nonce.</li>
            <li>On chain: the attestation was consumed once. A second use fails.</li>
          </ul></section>

        <section id="attested"><h2 className="title-1">Attested, not proven</h2>
          <ul className="copy-text">
            <li>L2 (embeddings) and L3 (model judge) verdicts. They are recorded in the audit log and can be run in a TEE (planned); their output is not inside the proof.</li>
            <li>The content of the audit log itself. The chain proves integrity and order of entries, not that an operator ran every call through the proxy.</li>
          </ul></section>

        <section id="not"><h2 className="title-1">Not covered</h2>
          <ul className="copy-text">
            <li>Traffic that does not pass through the proxy.</li>
            <li>Novel attacks the deterministic rules miss. On the published red-team corpus the proven layers alone catch roughly a third of attacks and little of the novel holdout set; detection in practice leans on L2/L3, which are attested rather than proven. The numbers are in <code>packages/LIMITATIONS.md</code> and are updated with every corpus change.</li>
            <li>The correctness of the gated program beyond the fields it forwards. Blindseal checks that the forwarded action equals the screened one; it does not audit the program.</li>
            <li>L0 decode-then-L1 is run by the proxy but is not yet inside the guest; the proof covers L1 on the payload as received. In-guest L0 is the next increment and will change the detector version.</li>
          </ul></section>

        <section id="privacy"><h2 className="title-1">What is public</h2>
          <p className="copy-text">Six hashes and a slot number. No prompt, no tool arguments, no policy contents or thresholds, no model scores, and nothing that names the agent or the operator. The explorer shows counts and policy roots only.</p></section>
      </div>
    </section>
  );
}
