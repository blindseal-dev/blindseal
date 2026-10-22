//! Blindseal SP1 host / prover (M0 stub).
//!
//! M0.5 spike: prove a minimal guest, Groth16-wrap, verify on localnet via sp1-solana.
//! M1: real prover that runs crates/guest, Groth16-wraps (bn254), and writes
//! attestation.json (see BLINDSEAL.md §3.5). Local CPU only — never the SP1 network prover.
fn main() {
    unimplemented!("M0.5/M1: SP1 prove -> Groth16 -> attestation.json (local only)")
}
