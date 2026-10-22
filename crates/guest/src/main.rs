//! Blindseal SP1 guest (M1 — minimal real guest). Reads the payload bytes and the serialized
//! L1 policy (forward dense-DFA bytes per rule), recomputes payloadHash, runs detector-core's
//! serialized L1 (no regex compilation in-zkVM, §3.4), asserts the deterministic layer PASSES
//! (clean), and commits payloadHash as a public value. L0 decoding, policyRoot, actionHash and
//! the nullifier are wired next; this first cut proves detector-core runs inside the zkVM.
#![no_main]
sp1_zkvm::entrypoint!(main);

use blindseal_detector_core::{run_layer1_serialized, SerializedL1, Severity};
use sha2::{Digest, Sha256};

pub fn main() {
    let payload: Vec<u8> = sp1_zkvm::io::read::<Vec<u8>>();
    let dfas: Vec<Vec<u8>> = sp1_zkvm::io::read::<Vec<Vec<u8>>>();

    let payload_hash: [u8; 32] = Sha256::digest(&payload).into();

    let text = String::from_utf8_lossy(&payload);
    let pol = SerializedL1 { dfas };
    let l1 = run_layer1_serialized(&text, &pol);

    // A failed assert aborts proving: a proof exists only if the deterministic layer PASSED.
    assert!(l1.verdict == Severity::Clean, "L1 did not pass");

    sp1_zkvm::io::commit(&payload_hash);
}
