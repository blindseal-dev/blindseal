# crates/ — Blindseal Rust (M0 stub)

Layout fixed in M0 per BLINDSEAL.md §4; **not yet compiled** (Rust/SP1 toolchains absent
in the M0 env — see DECISIONS.md).

- `detector-core` — L0 + L1 port (M1), shared by guest and parity tests.
- `guest` — SP1 guest; separate build unit for the SP1 riscv target (M0.5 spike → M1).
- `prover` — SP1 host → `attestation.json`; local CPU only, never the network prover (M1).
- `verifier-wasm` — off-chain Groth16 verifier compiled to WASM (M1).
