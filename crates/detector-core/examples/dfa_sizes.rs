//! Each L1 rule's serialized forward-DFA size: the bytes the guest deserializes and runs, and the bytes
//! the policy root commits to. A rule that does not determinize within RULE_DFA_SIZE_LIMIT is named here
//! instead of hanging the parity gate, so this is the first thing to run after editing a rule.
//!   cargo run --release --example dfa_sizes
use blindseal_detector_core::{rule_dfa_report, RULE_DFA_SIZE_LIMIT};
fn main() {
    let mut total = 0usize;
    let mut failed = 0usize;
    for (name, r) in rule_dfa_report() {
        match r {
            Ok(n) => {
                total += n;
                println!("{name:38} {n:>9} bytes");
            }
            Err(e) => {
                failed += 1;
                println!("{name:38} FAILED: {e}");
            }
        }
    }
    println!("total {total} bytes, {failed} rule(s) over the {RULE_DFA_SIZE_LIMIT}-byte limit");
}
