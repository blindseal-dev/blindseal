import { DocsNav } from '../nav';

export default function Concepts() {
  return (
    <section className="site-section s04 docs-shell">
      <DocsNav current="/docs/concepts" />
      <div className="docs-body">
        <h1 className="section-head__title">Concepts</h1>
        <p className="copy-text">Blindseal sits between an agent and its tools. Every call and result is screened locally, the decision is written to a hash-chained log, and — when the action touches a chain — a zero-knowledge proof binds the screening to that exact action. The five objects below are the whole model.</p>

        <section id="decision"><h2 className="title-1">Decision</h2>
          <p className="copy-text">One screened tool call or result. Four layers run in order: L0 decodes (base64, hex, URL, HTML entities, nested) and re-screens; L1 is a fixed set of regex rules compiled to DFAs; L2 compares embeddings against a corpus; L3 is a model judge. A decision carries a verdict (pass / flag / block), which layer decided, and the commitments below. The raw payload is encrypted at rest and can be revealed on the operator&apos;s explicit confirmation; it is never written to the chain or the log.</p></section>

        <section id="policy"><h2 className="title-1">Policy and the policy root</h2>
          <p className="copy-text">The policy is the set of deterministic rules in force. Its root is a Merkle root over one leaf per rule, where a regex rule&apos;s leaf hashes its compiled DFA bytes — so the root commits to exactly what the detector executes, not to a pattern string that could be compiled differently. Changing a rule, or the regex engine version, changes the root. Operators can register roots on chain and run the verifier in allowlist mode.</p></section>

        <section id="audit"><h2 className="title-1">Audit chain and disclosure</h2>
          <p className="copy-text">Each decision appends a content-free entry — decision id, verdict, payload hash, timestamp — whose hash includes the previous entry&apos;s hash. <code>audit verify</code> recomputes the chain from genesis; any edit shows as a break. A <em>disclosure</em> is a signed slice of the chain over a time window that a third party can verify offline against the proxy&apos;s identity key, without seeing any content.</p></section>

        <section id="attestation"><h2 className="title-1">Attestation</h2>
          <p className="copy-text">A Groth16 proof from an SP1 zkVM guest that: recomputed the payload hash, recomputed the policy root from the DFAs it ran, ran L1 and found the payload clean, and bound the on-chain action through an <em>action hash</em>. Its public inputs are six values — payload hash, policy root, detector version (the guest&apos;s verifying key), action hash, nullifier, expiry slot. Nothing about the content, the agent, or the operator is public. Proving is local, CPU-only and slow (hours on a laptop today); it is asynchronous by design and the numbers are published in <code>docs/performance.md</code>.</p></section>

        <section id="verifier"><h2 className="title-1">On-chain verifier and nullifier</h2>
          <p className="copy-text">A Solana program verifies the proof (one instruction, alt_bn128 syscalls) and consumes a <em>nullifier</em> — a PDA derived from the action hash — so an attestation can be used exactly once. A gated program calls it by CPI in the same transaction as the action it guards, passing the action fields <strong>it</strong> is about to execute; if they differ from the screened action the hash does not match and the transaction fails. If the action itself fails, the whole transaction reverts and the nullifier stays unconsumed. The verifier has a paused flag, a vkey allowlist and an optional policy-root allowlist, all authority-controlled.</p></section>

        <section id="mainnet"><h2 className="title-1">One chain</h2>
          <p className="copy-text">Solana mainnet is the only deploy target; <code>chainId 1</code> is the only chain id and the SDK refuses to send to any RPC whose genesis hash is not mainnet-beta&apos;s. Localnet exists for the test suite only.</p></section>
      </div>
    </section>
  );
}
