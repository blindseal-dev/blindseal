//! Tamper suite (M1, BLINDSEAL.md §3.7). A real attestation must verify; any single-byte change
//! to the proof, a public input, or the vkey (detectorVersion) must make verification fail. The
//! sample is a real Groth16 attestation from the detector-core guest (tests/fixtures/).
use blindseal_verifier::verify_attestation;
use serde_json::Value;

const SAMPLE: &str = include_str!("fixtures/attestation-sample.json");

/// Flip the last hex nibble of a `0x…` string so it stays valid hex but is a different value.
fn flip_last_nibble(s: &str) -> String {
    let last = &s[s.len() - 1..];
    let repl = if last == "0" { "1" } else { "0" };
    format!("{}{}", &s[..s.len() - 1], repl)
}

#[test]
fn valid_attestation_verifies() {
    let o = verify_attestation(SAMPLE);
    assert!(o.ok, "expected VALID, got {:?}", o.reason);
}

#[test]
fn flipped_proof_byte_fails() {
    let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
    let b = v["proof"]["bytes"].as_str().unwrap().to_string();
    v["proof"]["bytes"] = Value::String(flip_last_nibble(&b));
    let o = verify_attestation(&v.to_string());
    assert!(!o.ok, "a tampered proof must not verify");
}

#[test]
fn flipped_public_input_fails() {
    let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
    let p = v["publicInputs"][0].as_str().unwrap().to_string();
    v["publicInputs"][0] = Value::String(flip_last_nibble(&p));
    let o = verify_attestation(&v.to_string());
    assert!(!o.ok, "tampered public inputs must not verify");
}

#[test]
fn wrong_vkey_fails() {
    let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
    let k = v["detectorVersion"].as_str().unwrap().to_string();
    v["detectorVersion"] = Value::String(flip_last_nibble(&k));
    let o = verify_attestation(&v.to_string());
    assert!(!o.ok, "a different vkey must not verify this proof");
}

#[test]
fn empty_fields_fail_closed() {
    assert!(!verify_attestation("{}").ok, "missing fields must fail closed");
    assert!(!verify_attestation("not json").ok, "bad json must fail closed");
}
