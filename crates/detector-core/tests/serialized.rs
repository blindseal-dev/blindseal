//! The guest runs pre-serialized DFAs; this proves that path is identical to the
//! build-time path on every parity vector, so the proof covers the same L1 verdict the proxy
//! acts on. Serialize once, then compare run_layer1 vs run_layer1_serialized.
use blindseal_detector_core::{run_layer1, run_layer1_serialized, serialize_l1};
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
