//! Blindseal prover (M1). Feeds a payload + serialized L1 policy + action fields through the
//! SP1 guest, reads the six public values (payloadHash, policyRoot, detectorVersion, actionHash,
//! nullifier, expirySlot), and writes a full attestation.json. The guest asserts the
//! deterministic layer PASSED, so a proof exists only for a clean payload. Local CPU prover only.
//! `BLINDSEAL_EXECUTE=1` runs the zkVM executor (cycle count, no proof) for fast iteration.
use blindseal_detector_core::serialize_l1;
use sp1_sdk::{utils, HashableKey, Prover, ProverClient, SP1Stdin};
use std::time::Instant;

const GUEST_ELF: &[u8] = include_bytes!("../../guest/elf/blindseal-guest");
const SYSTEM_PROGRAM_32: [u8; 32] = [0u8; 32]; // base58 "111…1" decodes to 32 zero bytes

fn hex_str(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn hex_to_32(s: &str) -> [u8; 32] {
    let h = s.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

fn main() {
    utils::setup_logger();
    let client = ProverClient::builder().cpu().build();
    let (pk, vk) = client.setup(GUEST_ELF);
    let vkey = vk.bytes32();
    let detector_version = hex_to_32(&vkey);
    println!("VKEY {vkey}");

    // A benign (clean) payload + a sample SOL transfer action.
    let payload = b"The quick brown fox jumps over the lazy dog.".to_vec();
    let dfas = serialize_l1().dfas;
    let expiry_slot: u64 = 280_000_000;
    let nonce = [0xddu8; 32];

    let mut stdin = SP1Stdin::new();
    stdin.write(&payload);
    stdin.write(&dfas);
    stdin.write(&detector_version);
    stdin.write(&1u16); // chainId: solana mainnet
    stdin.write(&SYSTEM_PROGRAM_32); // targetProgram
    stdin.write(&[0x22u8; 32]); // sourceAuthority
    stdin.write(&[0x02u8, 0, 0, 0, 0, 0, 0, 0]); // instruction (transfer)
    stdin.write(&[0x33u8; 32]); // recipient
    stdin.write(&[0u8; 32]); // mint (native SOL)
    stdin.write(&1_000_000u64); // amount (lamports)
    stdin.write(&expiry_slot);
    stdin.write(&nonce);

    if std::env::var("BLINDSEAL_EXECUTE").is_ok() {
        let (mut pv, report) = client.execute(GUEST_ELF, &stdin).run().expect("execute failed");
        let payload_hash: [u8; 32] = pv.read();
        let policy_root: [u8; 32] = pv.read();
        let dv: [u8; 32] = pv.read();
        let action_hash: [u8; 32] = pv.read();
        let null: [u8; 32] = pv.read();
        let exp: u64 = pv.read();
        println!("CYCLES {}", report.total_instruction_count());
        println!("payloadHash {}", hex_str(&payload_hash));
        println!("policyRoot {}", hex_str(&policy_root));
        println!("detectorVersion {}", hex_str(&dv));
        println!("actionHash {}", hex_str(&action_hash));
        println!("nullifier {}", hex_str(&null));
        println!("expirySlot {exp}");
        return;
    }

    let t = Instant::now();
    let proof = client.prove(&pk, &stdin).groth16().run().expect("groth16 prove failed");
    let prove_ms = t.elapsed().as_millis();
    let proof_bytes = proof.bytes();

    let mut pv = proof.public_values;
    let payload_hash: [u8; 32] = pv.read();
    let policy_root: [u8; 32] = pv.read();
    let dv: [u8; 32] = pv.read();
    let action_hash: [u8; 32] = pv.read();
    let null: [u8; 32] = pv.read();
    let exp: u64 = pv.read();

    let att = serde_json::json!({
        "version": 1,
        "payloadHash": hex_str(&payload_hash),
        "policyRoot": hex_str(&policy_root),
        "detectorVersion": hex_str(&dv),
        "actionHash": hex_str(&action_hash),
        "nullifier": hex_str(&null),
        "expirySlot": exp,
        "proof": { "protocol": "groth16", "curve": "bn254", "bytes": hex_str(&proof_bytes) },
        "proveMs": prove_ms,
        "note": "L1-only screening (L0 decode-then-L1 in-guest is the next increment)"
    });
    std::fs::write("attestation.json", serde_json::to_string_pretty(&att).unwrap()).unwrap();
    println!("PROVE_MS {prove_ms}");
    println!("wrote attestation.json");
}
