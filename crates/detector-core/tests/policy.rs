//! Policy commitment (canonical hashing spec): deterministic Merkle root over the committed L1
//! rules + the zero-width threshold. The guest recomputes this and commits it as a public
//! value; the on-chain program allowlists roots. The root is written to
//! evals/vectors/policy-root.txt as the cross-language test vector (TS/on-chain assert it).
use blindseal_detector_core::{policy_leaf_count, policy_root, policy_root_hex, rule_dfa_report, RULE_DFA_SIZE_LIMIT};

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

#[test]
fn policy_root_from_serialized_matches() {
    use blindseal_detector_core::{policy_root, policy_root_from_serialized, serialize_l1};
    assert_eq!(policy_root_from_serialized(&serialize_l1()), policy_root());
}

/// Every committed rule must determinize within the per-rule cap, and the total is the input the guest
/// deserializes on every proof — it drives proving time (docs/performance.md), so a jump here is a
/// deliberate decision, not a surprise.
#[test]
fn every_rule_compiles_within_the_size_cap() {
    let mut total = 0usize;
    let mut over: Vec<String> = Vec::new();
    for (name, r) in rule_dfa_report() {
        match r {
            Ok(n) => total += n,
            Err(e) => over.push(format!("{name}: {e}")),
        }
    }
    assert!(over.is_empty(), "rules that do not compile within {RULE_DFA_SIZE_LIMIT} bytes:\n  {}", over.join("\n  "));
    eprintln!("serialized rule DFAs: {total} bytes over {} rules", rule_dfa_report().len());
}
