//! Payload-screening parity (release 0.8.0): detector-core `screen_payload` (what the guest asserts and
//! `blindseal-prover` pre-checks) must agree with the TypeScript `screenPayload` (what `blindseal attest`
//! checks) on every vector in evals/vectors/payload-screen.json — verdict, the order-independent union
//! of pattern names, and the number of distinct string leaves. Also checks the guest path (prepared DFAs,
//! stopping early) agrees on pass/fail. Regenerate with evals/parity/dump-vectors.ts.
use blindseal_detector_core::{screen_payload, screen_payload_prepared, serialize_l1, AlignedL1, Severity};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Vector {
    id: String,
    payload: String,
    verdict: String,
    patterns: Vec<String>,
    leaves: usize,
}

fn sev(s: &str) -> Severity {
    match s {
        "clean" => Severity::Clean,
        "suspicious" => Severity::Suspicious,
        "malicious" => Severity::Malicious,
        other => panic!("unknown verdict {other}"),
    }
}

#[test]
fn payload_screen_parity_with_ts_reference() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/payload-screen.json");
    let raw = std::fs::read_to_string(path).expect("read payload-screen.json (run dump-vectors.ts)");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("parse payload-screen.json");
    let aligned = AlignedL1::new(&serialize_l1());
    let prepared = aligned.prepare();

    let mut mismatches = Vec::new();
    let mut refused = 0usize;
    for v in &vectors {
        let r = screen_payload(v.payload.as_bytes());
        let want: BTreeSet<String> = v.patterns.iter().cloned().collect();
        if r.verdict != sev(&v.verdict) || r.patterns != want || r.leaves != v.leaves {
            mismatches.push(format!(
                "[{}] rust={:?} {:?} leaves={} ts={} {:?} leaves={}",
                v.id, r.verdict, r.patterns, r.leaves, v.verdict, want, v.leaves
            ));
        }
        let guest = screen_payload_prepared(v.payload.as_bytes(), &prepared);
        if guest.clean() != r.clean() {
            mismatches.push(format!("[{}] guest path clean={} host clean={}", v.id, guest.clean(), r.clean()));
        }
        if !r.clean() {
            refused += 1;
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} payload-screen mismatches across {} vectors (showing ≤40):\n{}",
        mismatches.len(),
        vectors.len(),
        mismatches[..mismatches.len().min(40)].join("\n")
    );
    eprintln!("payload screen: {} vectors ({refused} refused), 0 mismatches", vectors.len());
}

/// The four escape classes from the review must be refused (they passed raw-text screening before 0.8.0).
#[test]
fn review_escape_classes_are_refused() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/payload-screen.json");
    let vectors: Vec<Vector> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for id in ["esc:newline", "esc:tab", "esc:crlf", "esc:vtab", "esc:unicode-letter", "loc:key", "loc:nested"] {
        let v = vectors.iter().find(|v| v.id == id).unwrap_or_else(|| panic!("vector {id} missing"));
        assert!(!screen_payload(v.payload.as_bytes()).clean(), "{id} passed screening");
    }
}
