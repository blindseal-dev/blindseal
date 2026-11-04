//! The guest runs pre-serialized DFAs; this proves that path is identical to the
//! build-time path on every parity vector, so the proof covers the same L1 verdict the proxy
//! acts on. Serialize once, then compare run_layer1 vs run_layer1_serialized.
use blindseal_detector_core::{run_layer0, run_layer0_serialized, run_layer1, run_layer1_serialized, serialize_l1};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    id: String,
    input: String,
}

#[test]
fn serialized_dfa_execution_matches_build_time() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/parity.json");
    let raw = std::fs::read_to_string(path).expect("read parity.json");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("parse parity.json");
    let pol = serialize_l1();

    let mut mismatches = Vec::new();
    for v in &vectors {
        let a = run_layer1(&v.input);
        let b = run_layer1_serialized(&v.input, &pol);
        if a != b {
            mismatches.push(format!("[{}] build={:?} serialized={:?}", v.id, a, b));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} serialized/build-time mismatches:\n{}",
        mismatches.len(),
        mismatches[..mismatches.len().min(20)].join("\n")
    );
    eprintln!("serialized vs build-time: {} vectors, 0 mismatches", vectors.len());
}

/// The guest's L0 (serialized DFAs) equals the host's L0 (compiled rules) on every parity vector:
/// same fired/not-fired, same decoder path, same L1 result on the decoded text.
#[test]
fn serialized_l0_matches_build_time() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/parity.json");
    let raw = std::fs::read_to_string(path).expect("read parity.json");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("parse parity.json");
    let pol = serialize_l1();

    let mut mismatches = Vec::new();
    let mut fired = 0usize;
    for v in &vectors {
        let a = run_layer0(&v.input).map(|f| (f.decoder, f.l1));
        let b = run_layer0_serialized(&v.input, &pol).map(|f| (f.decoder, f.l1));
        if a.is_some() {
            fired += 1;
        }
        if a != b {
            mismatches.push(format!("[{}] build={:?} serialized={:?}", v.id, a, b));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} serialized/build-time L0 mismatches:\n{}",
        mismatches.len(),
        mismatches[..mismatches.len().min(20)].join("\n")
    );
    eprintln!("serialized vs build-time L0: {} vectors ({fired} fired), 0 mismatches", vectors.len());
}
