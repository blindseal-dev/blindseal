import { DocsNav } from '../nav';

// BLINDSEAL.md §3.3, verbatim. Edit the spec, then this file — never the other way round.
const SPEC = `payloadHash     = sha256(payload_bytes)            -- payload_bytes = canonical_json({tool, args}); no domain prefix in v1 (the shipped guest; see DECISIONS 2026-10-23)
policyRoot      = merkle_sha256(leaves), leaf_i = sha256("blindseal.rule.v1" || rule_id || layer || kind || compiled_bytes)
                  (compiled_bytes = DFA bytes for regex rules, raw value otherwise; tree sorted by rule_id; empty tree = sha256("blindseal.policy.empty.v1"))
detectorVersion = sp1 vkey hash of the guest program (bytes32)
actionHash      = sha256("blindseal.action.v1"
                  || chainId(u16 LE)           -- 1 = solana mainnet, 2 = reserved (no devnet), 3+ reserved for EVM
                  || targetProgram(32)
                  || sourceAuthority(32)       -- signer/authority the action executes under; zero if n/a
                  || instruction(8)            -- anchor discriminator or sha256(name)[..8]
                  || recipient(32)             -- zero if n/a
                  || mint(32)                  -- zero for native
                  || amount(u64 LE)            -- zero if n/a
                  || payloadHash(32)
                  || policyRoot(32)
                  || detectorVersion(32)
                  || expirySlot(u64 LE)
                  || nonce(32))                -- random per attestation
nullifier       = sha256("blindseal.nullifier.v1" || actionHash)`;

export default function Hashing() {
  return (
    <section className="site-section s04 docs-shell">
      <DocsNav current="/docs/hashing" />
      <div className="docs-body">
        <h1 className="section-head__title">Canonical hashing</h1>
        <p className="copy-text">All hashes are SHA-256 (a Solana syscall and an SP1 precompile), domain-separated. This is BLINDSEAL.md §3.3 verbatim; three implementations reproduce it byte for byte and are tested against each other: the Rust detector core (host and in-zkVM), the on-chain program, and the TypeScript SDK.</p>
        <pre className="code">{SPEC}</pre>
        <p className="copy-text">Nonce exists so two legitimately identical actions get distinct attestations. Nullifier is a pure function of the action hash so the consumer can&apos;t be tricked into accepting a nullifier for a different action.</p>
        <section id="public-inputs"><h2 className="title-1">Public inputs</h2>
          <p className="copy-text">The proof commits one 168-byte blob in this order: <code>payloadHash ‖ policyRoot ‖ detectorVersion ‖ actionHash ‖ nullifier</code> (five × 32 bytes) then <code>expirySlot</code> as a little-endian u64. The verifier (on chain and in the browser) checks the proof against the blob; UIs decode the blob into the six named fields for display.</p></section>
        <section id="pdas"><h2 className="title-1">On-chain addresses</h2>
          <pre className="code">{`Config     = PDA(["config"])
PolicyRoot = PDA(["policy", policyRoot32])
Nullifier  = PDA(["nullifier", nullifier32])     -- exists ⇔ consumed
program    = merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb  (Solana mainnet)`}</pre></section>
      </div>
    </section>
  );
}
