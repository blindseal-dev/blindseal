//! Blindseal prover (M1). Feeds a payload + the serialized L1 policy through the SP1 guest,
//! generates a local Groth16 proof (the guest asserts the deterministic layer PASSED, so a
//! proof exists only for a clean payload), and writes a minimal attestation.json. L0,
//! policyRoot recompute, actionHash and the nullifier are wired into the guest next; this
//! proves the real detector-core guest proves end to end. Local CPU prover only.
use blindseal_detector_core::{policy_root_hex, serialize_l1};
use sp1_sdk::{utils, HashableKey, Prover, ProverClient, SP1Stdin};
use std::time::Instant;

const GUEST_ELF: &[u8] = include_bytes!("../../guest/elf/blindseal-guest");

fn hex(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn main() {
    utils::setup_logger();
    let client = ProverClient::builder().cpu().build();
    let (pk, vk) = client.setup(GUEST_ELF);
    let vkey = vk.bytes32();
    println!("VKEY {vkey}");

    // A benign (clean) payload so the guest's L1 PASS assertion holds.
    let payload = b"The quick brown fox jumps over the lazy dog.".to_vec();
    let dfas = serialize_l1().dfas;

    let mut stdin = SP1Stdin::new();
    stdin.write(&payload);
    stdin.write(&dfas);

    // Fast path for iterating guest performance: run in the zkVM executor (no proof) and print
    // the cycle count. `BLINDSEAL_EXECUTE=1 cargo run --release`.
    if std::env::var("BLINDSEAL_EXECUTE").is_ok() {
        let (output, report) = client.execute(GUEST_ELF, &stdin).run().expect("execute failed");
        println!("CYCLES {}", report.total_instruction_count());
        println!("PUBLIC_VALUES_BYTES {}", output.as_slice().len());
        return;
    }

    let t = Instant::now();
    let proof = client.prove(&pk, &stdin).groth16().run().expect("groth16 prove failed");
    let prove_ms = t.elapsed().as_millis();
    let proof_bytes = proof.bytes();
    let public_inputs = proof.public_values.to_vec();
    println!("PROVE_MS {prove_ms}");
    println!("PROOF_BYTES {}", proof_bytes.len());
    println!("PUBLIC_INPUTS_BYTES {}", public_inputs.len());

    let att = serde_json::json!({
        "version": 1,
        "detectorVersion": vkey,
        "policyRoot": policy_root_hex(),
        "publicInputs": [hex(&public_inputs)],
        "proof": { "protocol": "groth16", "curve": "bn254", "bytes": hex(&proof_bytes) },
        "proveMs": prove_ms,
        "note": "minimal attestation (payloadHash committed; L0/actionHash/nullifier wired next)"
    });
    std::fs::write("attestation.json", serde_json::to_string_pretty(&att).unwrap()).unwrap();
    println!("wrote attestation.json");
}
