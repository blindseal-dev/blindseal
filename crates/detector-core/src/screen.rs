//! Payload screening as the proof asserts it (release 0.8.0).
//!
//! The screened payload is the tool call serialized as JSON (`JSON.stringify({tool, args})`). In that
//! serialization control characters and other escapable characters become two-character escapes
//! (`\n`, `\t`, `\u000b`, `i`, `\"`), so L1 and L0 run on the raw text alone miss an injection
//! that only reads as one once unescaped — "ignore\nprevious instructions" in an argument. Releases
//! before 0.8.0 screened the raw text only; the live proxy, which screens each string of the parsed
//! call, was not affected.
//!
//! The proof now asserts L1 and L0 pass on:
//!  1. the raw payload text, and
//!  2. every JSON string leaf of the parsed payload — object keys and string values, at any depth,
//!     unescaped — each screened as its own text.
//!
//! The payload must parse as JSON (serde_json, default recursion limit). A payload that does not parse
//! is refused (pattern `unparseable-payload`); the guest's payload/action binding requires a JSON tool
//! call anyway. The result is order-independent — the union of pattern names over all texts — because
//! the two JSON parsers do not visit object members in the same order. TypeScript mirror:
//! `packages/proxy/src/detection/proven.ts` (`screenPayload`); both run `evals/vectors/payload-screen.json`.

use crate::{run_layer0_with, run_layer1, run_layer1_prepared, PreparedL1, RawResult, Severity};
use serde_json::Value;
use std::collections::BTreeSet;

pub const UNPARSEABLE: &str = "unparseable-payload";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenResult {
    /// The highest severity over every screened text (Clean only if every text passed both layers).
    pub verdict: Severity,
    /// Union of L1 pattern names over every text, from L1 directly and from the L1 match of the first
    /// L0 candidate that fired.
    pub patterns: BTreeSet<String>,
    /// Number of distinct string leaves screened (keys and values).
    pub leaves: usize,
}

impl ScreenResult {
    pub fn clean(&self) -> bool {
        self.verdict == Severity::Clean
    }
}

fn collect(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::String(s) => {
            out.insert(s.clone());
        }
        Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                out.insert(k.clone());
                collect(x, out);
            }
        }
        _ => {}
    }
}

/// Every distinct string leaf (object keys and string values, any depth), unescaped. None when the
/// payload is not JSON.
pub fn json_string_leaves(payload: &[u8]) -> Option<BTreeSet<String>> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    let mut out = BTreeSet::new();
    collect(&v, &mut out);
    Some(out)
}

fn absorb(r: &RawResult, verdict: &mut Severity, patterns: &mut BTreeSet<String>) {
    if r.verdict > *verdict {
        *verdict = r.verdict;
    }
    patterns.extend(r.patterns.iter().cloned());
}

/// Screen `payload` with `l1` as the L1 evaluator (compiled rules on the host, prepared DFAs in the
/// guest). With `stop_early`, return as soon as one text fails (the guest only needs pass/fail).
pub fn screen_payload_with(payload: &[u8], l1: &dyn Fn(&str) -> RawResult, stop_early: bool) -> ScreenResult {
    let mut verdict = Severity::Clean;
    let mut patterns = BTreeSet::new();
    let Some(leaves) = json_string_leaves(payload) else {
        patterns.insert(UNPARSEABLE.to_string());
        return ScreenResult { verdict: Severity::Malicious, patterns, leaves: 0 };
    };
    let raw = String::from_utf8_lossy(payload);
    let n = leaves.len();
    let texts = std::iter::once(raw.as_ref()).chain(leaves.iter().map(String::as_str));
    for t in texts {
        absorb(&l1(t), &mut verdict, &mut patterns);
        if let Some(fire) = run_layer0_with(t, l1) {
            absorb(&fire.l1, &mut verdict, &mut patterns);
        }
        if stop_early && verdict != Severity::Clean {
            break;
        }
    }
    ScreenResult { verdict, patterns, leaves: n }
}

/// Host path (compiled rules): the full result, for `blindseal-prover`'s pre-check and the parity gate.
pub fn screen_payload(payload: &[u8]) -> ScreenResult {
    screen_payload_with(payload, &run_layer1, false)
}

/// Guest path (prepared DFAs), stopping at the first failing text.
pub fn screen_payload_prepared(payload: &[u8], pol: &PreparedL1<'_>) -> ScreenResult {
    screen_payload_with(payload, &|t| run_layer1_prepared(t, pol), true)
}
