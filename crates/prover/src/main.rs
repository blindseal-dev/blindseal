//! Blindseal prover (M1/M2). Feeds a payload + serialized L1 policy + the on-chain action
//! through the SP1 guest, reads the six public values (payloadHash, policyRoot, detectorVersion,
//! actionHash, nullifier, expirySlot), and writes a full attestation.json. The guest asserts the
//! deterministic layer PASSED, so a proof exists only for a clean payload. Local CPU prover only.
//!
//! The action fields are the ones the gated program will execute: the proof binds the
//! target program, the source authority the transfer debits, the recipient, mint, amount and
//! the instruction discriminator. The private `nonce` is carried in the attestation so the
//! on-chain program can recompute actionHash; it is not a public value.
//!
//! `BLINDSEAL_EXECUTE=1` runs the zkVM executor (cycle count, no proof) for fast iteration.
use blindseal_detector_core::serialize_l1;
use sp1_sdk::{utils, HashableKey, Prover, ProverClient, SP1Stdin};
use std::time::Instant;

const GUEST_ELF: &[u8] = include_bytes!("../../guest/elf/blindseal-guest");

const USAGE: &str = "blindseal-prover --payload <file> --out <attestation.json>
  --target-program <base58> --source-authority <base58> --recipient <base58>
  [--mint <base58>] --amount <u64> --instruction <16 hex> [--expiry <slot>]
  [--nonce <64 hex>] [--chain-id <u16>] [--decision-id <id>]";

fn hex_str(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn hex_to_32(s: &str) -> [u8; 32] {
    let h = s.trim_start_matches("0x");
    assert_eq!(h.len(), 64, "expected 32-byte hex, got {s}");
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

fn hex_to_8(s: &str) -> [u8; 8] {
    let h = s.trim_start_matches("0x");
    assert_eq!(h.len(), 16, "expected 8-byte hex, got {s}");
    let mut out = [0u8; 8];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

/// base58 pubkey → 32 bytes; empty string → all zeros (n/a / native asset).
fn pk32(s: &str) -> [u8; 32] {
    if s.is_empty() {
        return [0u8; 32];
    }
    let v = bs58::decode(s).into_vec().unwrap_or_else(|e| panic!("bad base58 {s}: {e}"));
    assert_eq!(v.len(), 32, "pubkey {s} is not 32 bytes");
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

struct Args {
    payload: Vec<u8>,
    out: String,
    target_program: String,
    source_authority: String,
    recipient: String,
    mint: String,
    amount: u64,
    instruction: [u8; 8],
    expiry_slot: u64,
    nonce: [u8; 32],
    chain_id: u16,
    decision_id: Option<String>,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().collect();
    let get = |k: &str| -> Option<String> {
        argv.iter().position(|a| a == k).and_then(|i| argv.get(i + 1).cloned())
    };
    let payload_path = get("--payload").unwrap_or_else(|| panic!("--payload required\n{USAGE}"));
    let payload = std::fs::read(&payload_path).unwrap_or_else(|e| panic!("read {payload_path}: {e}"));
    let nonce = match get("--nonce") {
        Some(n) => hex_to_32(&n),
        None => {
            // fresh randomness: never reuse a nonce across attestations (the nullifier is a
            // pure function of actionHash, which folds the nonce in)
            let mut b = [0u8; 32];
            getrandom_fill(&mut b);
            b
        }
    };
    Args {
        payload,
        out: get("--out").unwrap_or_else(|| "attestation.json".into()),
        target_program: get("--target-program").unwrap_or_else(|| panic!("--target-program required\n{USAGE}")),
        source_authority: get("--source-authority").unwrap_or_else(|| panic!("--source-authority required\n{USAGE}")),
        recipient: get("--recipient").unwrap_or_default(),
        mint: get("--mint").unwrap_or_default(),
        amount: get("--amount").map(|a| a.parse().expect("--amount u64")).unwrap_or(0),
        instruction: hex_to_8(&get("--instruction").unwrap_or_else(|| panic!("--instruction required\n{USAGE}"))),
        expiry_slot: get("--expiry").map(|e| e.parse().expect("--expiry u64")).unwrap_or(2_000_000_000),
        nonce,
        chain_id: get("--chain-id").map(|c| c.parse().expect("--chain-id u16")).unwrap_or(1),
        decision_id: get("--decision-id"),
    }
}

/// OS randomness via /dev/urandom (no extra crate; the prover is a host binary).
fn getrandom_fill(buf: &mut [u8]) {
    use std::io::Read;
    std::fs::File::open("/dev/urandom").expect("urandom").read_exact(buf).expect("urandom read");
}

fn main() {
    utils::setup_logger();
    let args = parse_args();
    let client = ProverClient::builder().cpu().build();
    let (pk, vk) = client.setup(GUEST_ELF);
    let vkey = vk.bytes32();
    let detector_version = hex_to_32(&vkey);
    println!("VKEY {vkey}");

    let dfas = serialize_l1().dfas;
    let mut stdin = SP1Stdin::new();
    stdin.write(&args.payload);
    stdin.write(&dfas);
    stdin.write(&detector_version);
    stdin.write(&args.chain_id);
    stdin.write(&pk32(&args.target_program));
    stdin.write(&pk32(&args.source_authority));
    stdin.write(&args.instruction);
    stdin.write(&pk32(&args.recipient));
    stdin.write(&pk32(&args.mint));
    stdin.write(&args.amount);
    stdin.write(&args.expiry_slot);
    stdin.write(&args.nonce);

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

    // Raw committed public-values blob (what sp1-verifier / sp1-solana verify against) — capture
    // before reading advances the cursor.
    let pub_blob = proof.public_values.as_slice().to_vec();
    let mut pv = proof.public_values;
    let payload_hash: [u8; 32] = pv.read();
    let policy_root: [u8; 32] = pv.read();
    let dv: [u8; 32] = pv.read();
    let action_hash: [u8; 32] = pv.read();
    let null: [u8; 32] = pv.read();
    let exp: u64 = pv.read();

    let att = serde_json::json!({
        "version": 1,
        "decisionId": args.decision_id,
        "chainId": args.chain_id,
        "payloadHash": hex_str(&payload_hash),
        "policyRoot": hex_str(&policy_root),
        "detectorVersion": hex_str(&dv),
        "actionHash": hex_str(&action_hash),
        "nullifier": hex_str(&null),
        "expirySlot": exp,
        "nonce": hex_str(&args.nonce),
        "action": {
            "targetProgram": args.target_program,
            "sourceAuthority": args.source_authority,
            "instruction": hex_str(&args.instruction),
            "recipient": args.recipient,
            "mint": args.mint,
            "amount": args.amount.to_string(),
        },
        "publicInputs": [hex_str(&pub_blob)],
        "proof": { "protocol": "groth16", "curve": "bn254", "bytes": hex_str(&proof_bytes) },
        "proveMs": prove_ms,
        "note": "L1-only screening (L0 decode-then-L1 in-guest is the next increment)"
    });
    std::fs::write(&args.out, serde_json::to_string_pretty(&att).unwrap()).unwrap();
    println!("PROVE_MS {prove_ms}");
    println!("wrote {}", args.out);
}
