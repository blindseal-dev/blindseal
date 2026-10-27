# programs/ — Blindseal Solana programs (Anchor 0.31.1)

Built with `scripts/build-programs.sh` (`cargo build-sbf --tools-version v1.57` + `anchor idl build`);
the on-chain suite runs on a local validator with `scripts/test-m2.sh`.

- `blindseal-verify` — Groth16 verify (sp1-solana) + nullifier set + vkey/policy allowlists; CPI-only.
  The exact check order is documented in the header of `blindseal-verify/src/lib.rs`.
- `transfer-gate` — example gated native-SOL transfer that requires an attestation.
- `rogue-caller` — TEST-ONLY native forwarder for the M2 suite (a CPI from a program other than the
  attestation's target must fail); loaded at an id generated per test run, never deployed.
