//! Blindseal SP1 guest (M1). Recomputes payloadHash and policyRoot, runs detector-core's L1 on
//! pre-serialized DFAs (no regex compilation in-zkVM), asserts the deterministic layer
//! PASSES (a proof exists only if clean), binds the on-chain action via actionHash + nullifier,
//! and commits the public values. detectorVersion is a public INPUT (the guest cannot know its
//! own vkey); the Solana program checks it equals the vkey it verified with.
//!
//! Public value commit order: payloadHash, policyRoot, detectorVersion, actionHash, nullifier,
//! expirySlot. Remaining for a later increment: L0 decode-then-L1 on serialized decoder DFAs.
#![no_main]
sp1_zkvm::entrypoint!(main);

use blindseal_detector_core::{
    action_hash, nullifier, policy_root_from_serialized, run_layer1_serialized, ActionFields,
    Commitments, SerializedL1, Severity,
};
use sha2::{Digest, Sha256};

pub fn main() {
    // private inputs
    let payload: Vec<u8> = sp1_zkvm::io::read();
    let dfas: Vec<Vec<u8>> = sp1_zkvm::io::read();
    let detector_version: [u8; 32] = sp1_zkvm::io::read();
    let chain_id: u16 = sp1_zkvm::io::read();
    let target_program: [u8; 32] = sp1_zkvm::io::read();
    let source_authority: [u8; 32] = sp1_zkvm::io::read();
    let instruction: [u8; 8] = sp1_zkvm::io::read();
    let recipient: [u8; 32] = sp1_zkvm::io::read();
    let mint: [u8; 32] = sp1_zkvm::io::read();
    let amount: u64 = sp1_zkvm::io::read();
    let expiry_slot: u64 = sp1_zkvm::io::read();
    let nonce: [u8; 32] = sp1_zkvm::io::read();

    // 1) commit payloadHash, 2) recompute policyRoot from the provided DFAs
    let payload_hash: [u8; 32] = Sha256::digest(&payload).into();
    let pol = SerializedL1 { dfas };
    let policy_root = policy_root_from_serialized(&pol);

    // 3) deterministic layer must PASS (proof exists only for a clean payload)
    let text = String::from_utf8_lossy(&payload);
    let l1 = run_layer1_serialized(&text, &pol);
    assert!(l1.verdict == Severity::Clean, "L1 did not pass");

    // 4) bind the action
    let action = ActionFields {
        chain_id,
        target_program,
        source_authority,
        instruction,
        recipient,
        mint,
        amount,
    };
    let commitments = Commitments { payload_hash, policy_root, detector_version, expiry_slot, nonce };
    let ah = action_hash(&action, &commitments);
    let nf = nullifier(&ah);

    // public values (fixed order)
    sp1_zkvm::io::commit(&payload_hash);
    sp1_zkvm::io::commit(&policy_root);
    sp1_zkvm::io::commit(&detector_version);
    sp1_zkvm::io::commit(&ah);
    sp1_zkvm::io::commit(&nf);
    sp1_zkvm::io::commit(&expiry_slot);
}
