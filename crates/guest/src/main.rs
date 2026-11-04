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
//! same serialized DFAs. Both layers run on the raw payload AND on every JSON string leaf (keys and
//! values, unescaped, any depth): JSON escapes (`\n`, `\t`, `\u0069`) hide an injection from the raw
//! text alone. A proof exists only if every text passes (detector-core `screen`).
//!
//! Release 0.8.0 also adds a stateless action policy (allowed recipients, max amount, allowed target
//! programs, instructions and mints; empty = no constraint) that the bound action must satisfy. The
//! committed policyRoot = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash).
//!
//! Public value commit order: payloadHash, policyRoot, detectorVersion, actionHash, nullifier,
//! expirySlot.
#![no_main]
sp1_zkvm::entrypoint!(main);

use blindseal_detector_core::{
    action_hash, check_action_binding, nullifier, policy_root_from_serialized, policy_root_v2,
    screen_payload_prepared, ActionFields, ActionPolicy, AlignedL1, Commitments, SerializedL1,
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
    // action policy (release 0.8.0); empty lists / None = no constraint
    let policy = ActionPolicy {
        recipients: sp1_zkvm::io::read::<Vec<[u8; 32]>>(),
        max_amount: sp1_zkvm::io::read::<Option<u64>>(),
        target_programs: sp1_zkvm::io::read::<Vec<[u8; 32]>>(),
        instructions: sp1_zkvm::io::read::<Vec<[u8; 8]>>(),
        mints: sp1_zkvm::io::read::<Vec<[u8; 32]>>(),
    }
    .canonical();

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
    // 0b) the action must satisfy the committed action policy
    if let Err(e) = policy.check(&action) {
        panic!("action policy refused: {}", e.code());
    }

    // 1) commit payloadHash, 2) recompute policyRoot from the provided DFAs
    let payload_hash: [u8; 32] = Sha256::digest(&payload).into();
    let pol = SerializedL1 { dfas };
    let rules_root = policy_root_from_serialized(&pol);
    let policy_root = policy_root_v2(&rules_root, &policy.hash());

    // 3) the deterministic layers must PASS (a proof exists only for a clean payload): L1 and L0 on
    //    the raw text and on every JSON string leaf, with the rule DFAs deserialized once
    let aligned = AlignedL1::new(&pol);
    let prepared = aligned.prepare();
    let screened = screen_payload_prepared(&payload, &prepared);
    assert!(screened.clean(), "screening did not pass: {:?}", screened.patterns);

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
