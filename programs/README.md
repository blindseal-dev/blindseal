# programs/ — Blindseal Solana/Anchor (M0 stub)

Layout fixed in M0 per BLINDSEAL.md §4; built with `anchor build` in M2 (toolchains absent
in the M0 env — see DECISIONS.md).

- `blindseal-verify` — Groth16 verify (sp1-solana) + nullifier set + policy allowlist; CPI-able.
- `transfer-gate` — example gated SPL transfer that requires an attestation.
- `rogue-caller` — TEST-ONLY native forwarder for the M2 suite (a CPI from a program other than the
  attestation's target must fail); loaded at an id generated per test run, never deployed.
