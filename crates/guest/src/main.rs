//! Blindseal SP1 guest. Recomputes payloadHash and policyRoot, runs detector-core's L0 + L1 on
//! pre-serialized DFAs (no regex compilation in-zkVM), asserts the deterministic layer
//! PASSES (a proof exists only if clean), binds the on-chain action via actionHash + nullifier,
//! and commits the public values. detectorVersion is a public INPUT (the guest cannot know its
//! own vkey); the Solana program checks it equals the vkey it verified with.
//!
//! Step 0 (release 0.7.0): before hashing, the payload is parsed into the on-chain action it
//! describes (detector-core `action_binding`, mirrored by `blindseal attest`) and every action
//! field — chainId, targetProgram, instruction, sourceAuthority, recipient, mint, amount — must
//! equal the action the proof binds. A payload that does not parse to an on-chain action, or that
//! describes a different one, cannot be attested.
//!
//! Release 0.8.0: L0 runs in the guest too. The payload is decoded (base64, hex, URL, HTML entities,
//! zero-width strip, NFKC, homoglyph fold; nested to depth 3) and L1 runs over every variant on the
//! same serialized DFAs; a proof exists only if the raw text AND every decoded variant pass.
//!
//! Public value commit order: payloadHash, policyRoot, detectorVersion, actionHash, nullifier,
//! expirySlot.
#![no_main]
sp1_zkvm::entrypoint!(main);

use blindseal_detector_core::{
    action_hash, check_action_binding, nullifier, policy_root_from_serialized, run_layer0_serialized,
    run_layer1_serialized, ActionFields, Commitments, SerializedL1, Severity,
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

    // 0) the payload must describe exactly this action
    let action = ActionFields {
        chain_id,
        target_program,
        source_authority,
        instruction,
        recipient,
        mint,
        amount,
    };
    if let Err(e) = check_action_binding(&payload, &action) {
        panic!("payload/action binding refused: {}", e.code());
    }

    // 1) commit payloadHash, 2) recompute policyRoot from the provided DFAs
    let payload_hash: [u8; 32] = Sha256::digest(&payload).into();
    let pol = SerializedL1 { dfas };
    let policy_root = policy_root_from_serialized(&pol);

    // 3) the deterministic layers must PASS (proof exists only for a clean payload): L1 on the raw
    //    text, then L0 (decode-then-L1) on every decoded variant
    let text = String::from_utf8_lossy(&payload);
    let l1 = run_layer1_serialized(&text, &pol);
    assert!(l1.verdict == Severity::Clean, "L1 did not pass");
    if let Some(fire) = run_layer0_serialized(&text, &pol) {
        panic!("L0 did not pass ({})", fire.decoder);
    }

    // 4) bind the action (checked against the payload in step 0)
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
