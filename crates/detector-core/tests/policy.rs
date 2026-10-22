//! Policy commitment (BLINDSEAL.md §3.3): deterministic Merkle root over the committed L1
//! rules + the zero-width threshold. The guest recomputes this and commits it as a public
//! value; the on-chain program allowlists roots. The root is written to
//! evals/vectors/policy-root.txt as the cross-language test vector (TS/on-chain assert it).
use blindseal_detector_core::{policy_leaf_count, policy_root, policy_root_hex};

#[test]
fn policy_root_is_deterministic_and_nonempty() {
    assert_eq!(policy_root(), policy_root(), "root must be deterministic");
    let hex = policy_root_hex();
    assert!(hex.starts_with("0x") && hex.len() == 66, "0x + 64 hex chars, got {hex}");
    assert_ne!(policy_root(), [0u8; 32], "root is not zero");
    assert!(policy_leaf_count() >= 20, "expected the full rule set, got {}", policy_leaf_count());

    // write the shared cross-language test vector
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/policy-root.txt");
    std::fs::write(
        path,
        format!("# Blindseal policy root (detector-core default policy). Shared vector; TS + on-chain must match.\n{}\n{} leaves\n", hex, policy_leaf_count()),
    )
    .expect("write policy-root.txt");
    eprintln!("policy root = {hex} ({} leaves)", policy_leaf_count());
}
