//! Blindseal on-chain verifier (M0 stub). See BLINDSEAL.md §3.7.
//!
//! M2 implements `verify_and_consume(proof, public_inputs, action)`: pause check,
//! vkey allowlist, policy-root allowlist, expiry, actionHash recompute (incl.
//! sourceAuthority), nullifier recompute + PDA create, Groth16 verify via sp1-solana.
//! CPI-able; the gated program passes the action fields IT is about to execute.
