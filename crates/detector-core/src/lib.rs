//! Blindseal L0 + L1 detector core (M0 stub).
//!
//! M1 ports Blindseal's TS L0 (decode-then-L1) and L1 (DFA executor) here, verbatim in
//! behaviour, and the parity harness in `evals/` gates CI at 100% agreement on the clean
//! holdout — comparing RAW L0/L1 verdicts, not the combined pipeline verdict (L2 can
//! overrule L1). See BLINDSEAL.md §3.2/§3.4 and DECISIONS.md.

/// Raw deterministic verdict of the proven layers (L0 decode + L1 DFA). Not the combined
/// pipeline verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawVerdict {
    Pass,
    Fail,
}

/// TODO(M1): real L0 decode-then-L1 + L1 DFA executor over a committed policy.
pub fn screen_raw(_payload: &[u8]) -> RawVerdict {
    unimplemented!("M1: port Blindseal L0/L1 to Rust; gate on parity harness")
}
