//! Blindseal off-chain attestation verifier (M1). Checks the SP1 Groth16 proof in an
//! attestation.json against its committed public inputs and the pinned detectorVersion (vkey),
//! using sp1-verifier's SP1 v5 Groth16 verifying key. The verify page and the tamper suite use
//! this; the on-chain program (M2) does the same check via sp1-solana. No proof generation.
use sp1_verifier::{Groth16Verifier, GROTH16_VK_BYTES};

#[derive(Debug, Clone)]
pub struct Outcome {
    pub ok: bool,
    pub reason: Option<String>,
}

fn hex_to_vec(s: &str) -> Vec<u8> {
    let h = s.trim_start_matches("0x");
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect()
}

/// Verify an attestation JSON string. Checks the Groth16 proof against the committed
/// publicInputs and the detectorVersion (vkey hash). Does NOT check expiry/nullifier/policy
/// allowlist — that is the consumer's / on-chain program's job (§3.7).
pub fn verify_attestation(json: &str) -> Outcome {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => return Outcome { ok: false, reason: Some(format!("bad json: {e}")) },
    };
    let proof = hex_to_vec(v["proof"]["bytes"].as_str().unwrap_or(""));
    let public_inputs = hex_to_vec(v["publicInputs"][0].as_str().unwrap_or(""));
    let vkey = v["detectorVersion"].as_str().unwrap_or("");
    if proof.is_empty() || public_inputs.is_empty() || vkey.is_empty() {
        return Outcome { ok: false, reason: Some("missing proof/publicInputs/detectorVersion".into()) };
    }
    match Groth16Verifier::verify(&proof, &public_inputs, vkey, &GROTH16_VK_BYTES) {
        Ok(()) => Outcome { ok: true, reason: None },
        Err(e) => Outcome { ok: false, reason: Some(format!("{e:?}")) },
    }
}
