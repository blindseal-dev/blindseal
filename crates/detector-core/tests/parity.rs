//! L0/L1 parity gate: detector-core must agree with the TS reference on every vector in
//! evals/vectors/parity.json (raw verdict + pattern SET, for both L1 and L0). Regenerate the
//! vectors with evals/parity/dump-vectors.ts.
use blindseal_detector_core::{run_layer0, run_layer1, Severity};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Vector {
    id: String,
    input: String,
    l1_verdict: String,
    l1_patterns: Vec<String>,
    l0_fired: bool,
    l0_verdict: Option<String>,
    l0_l1_patterns: Vec<String>,
}

fn sev(s: &str) -> Severity {
    match s {
        "clean" => Severity::Clean,
        "suspicious" => Severity::Suspicious,
        "malicious" => Severity::Malicious,
        other => panic!("unknown verdict {other}"),
    }
}

fn set(v: &[String]) -> BTreeSet<String> {
    v.iter().cloned().collect()
}

#[test]
fn parity_with_ts_reference() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/parity.json");
    let raw = std::fs::read_to_string(path).expect("read parity.json (run dump-vectors.ts)");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("parse parity.json");

    let mut mismatches: Vec<String> = Vec::new();
    for v in &vectors {
        // L1
        let l1 = run_layer1(&v.input);
        if l1.verdict != sev(&v.l1_verdict) {
            mismatches.push(format!("[{}] L1 verdict: rust={:?} ts={}", v.id, l1.verdict, v.l1_verdict));
        }
        if set(&l1.patterns) != set(&v.l1_patterns) {
            mismatches.push(format!(
                "[{}] L1 patterns: rust={:?} ts={:?}",
                v.id, set(&l1.patterns), set(&v.l1_patterns)
            ));
        }
        // L0
        let l0 = run_layer0(&v.input);
        let fired = l0.is_some();
        if fired != v.l0_fired {
            mismatches.push(format!("[{}] L0 fired: rust={} ts={}", v.id, fired, v.l0_fired));
        } else if let Some(fire) = l0 {
            if let Some(tv) = &v.l0_verdict {
                if fire.l1.verdict != sev(tv) {
                    mismatches.push(format!("[{}] L0 verdict: rust={:?} ts={}", v.id, fire.l1.verdict, tv));
                }
            }
            if set(&fire.l1.patterns) != set(&v.l0_l1_patterns) {
                mismatches.push(format!(
                    "[{}] L0 patterns: rust={:?} ts={:?}",
                    v.id, set(&fire.l1.patterns), set(&v.l0_l1_patterns)
                ));
            }
        }
    }

    if !mismatches.is_empty() {
        let shown = mismatches.len().min(40);
        panic!(
            "{} parity mismatches across {} vectors (showing {}):\n{}",
            mismatches.len(),
            vectors.len(),
            shown,
            mismatches[..shown].join("\n")
        );
    }
    eprintln!("parity: {} vectors, 0 mismatches", vectors.len());
}
