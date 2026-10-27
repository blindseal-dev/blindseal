# crates/ — Blindseal Rust

- `detector-core` — L0 + L1 port of the proxy's deterministic layers, shared by the guest and the parity
  tests (`cargo test` at the repo root; vectors in `evals/vectors/`).
- `guest` — the SP1 guest; separate build unit for the SP1 riscv target (succinct toolchain, Rust 1.85).
  The prebuilt ELF is committed under `guest/elf/`.
- `prover` — SP1 host → `attestation.json`; local CPU proving only, never the network prover.
- `verifier-wasm` — the off-chain Groth16 verifier, built natively for its tests and to WebAssembly
  for `packages/verifier-wasm`.
