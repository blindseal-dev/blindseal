//! CLI: `blindseal-verify <attestation.json>` — off-chain verify an attestation. Exit 0 if valid.
use std::process::exit;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "attestation.json".to_string());
    let json = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("read {path}: {e}");
        exit(2);
    });
    let out = blindseal_verifier::verify_attestation(&json);
    if out.ok {
        println!("VALID — attestation verifies ({path})");
        exit(0);
    } else {
        println!("INVALID — {} ({path})", out.reason.unwrap_or_default());
        exit(1);
    }
}
