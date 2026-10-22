//! Blindseal M0.5 verifier spike host: prove the minimal guest with Groth16, then verify
//! the proof on the Solana runtime via sp1-solana (GROTH16_VK_5_0_0_BYTES). Local CPU
//! prover only — never the SP1 network prover.
//!
//! Verification runs through `solana-program-test` (banks client), which executes the
//! on-chain program and its alt_bn128 syscalls. A tampered-input case must be rejected so
//! the pass is non-vacuous. Representative compute units require a real validator deploy
//! (see docs/performance.md) — program-test's native processor does not meter BPF compute.
use blindseal_m05_program::{process_instruction, SP1Groth16Proof};
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer,
    transaction::Transaction,
};
use sp1_sdk::{utils, HashableKey, Prover, ProverClient, SP1ProofWithPublicValues, SP1Stdin};
use std::time::Instant;

const ELF: &[u8] = include_bytes!("../../sp1-program/elf/blindseal-m05-guest");

#[tokio::main]
async fn main() {
    utils::setup_logger();

    // 1) setup -> verification key
    let client = ProverClient::builder().cpu().build();
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = vk.bytes32();
    println!("VKEY_HASH {}", vkey_hash);

    // 2) Groth16 prove (timed). Cache to disk so reruns don't re-prove (~4 min each).
    let proof_path = "m05_proof.bin";
    let (proof, prove_ms): (SP1ProofWithPublicValues, u128) =
        if std::path::Path::new(proof_path).exists() {
            println!("PROVE_MS cached");
            (SP1ProofWithPublicValues::load(proof_path).expect("load proof"), 0)
        } else {
            let input: Vec<u8> = b"blindseal-m05-spike".to_vec();
            let mut stdin = SP1Stdin::new();
            stdin.write(&input);
            let t = Instant::now();
            let p = client.prove(&pk, &stdin).groth16().run().expect("groth16 prove failed");
            let ms = t.elapsed().as_millis();
            p.save(proof_path).expect("save proof");
            println!("PROVE_MS {}", ms);
            (p, ms)
        };
    let proof_bytes = proof.bytes();
    let public_inputs = proof.public_values.to_vec();
    println!("PROOF_BYTES {}", proof_bytes.len());
    println!("PUBLIC_INPUTS_BYTES {}", public_inputs.len());

    // 3) verify on the Solana runtime (alt_bn128 syscalls via sp1-solana)
    let program_id = Pubkey::new_unique();
    let (banks, payer, blockhash) =
        ProgramTest::new("blindseal_m05_program", program_id, processor!(process_instruction))
            .start()
            .await;

    let make_tx = |pub_inputs: Vec<u8>, bh| {
        let ix_data = SP1Groth16Proof {
            proof: proof_bytes.clone(),
            sp1_public_inputs: pub_inputs,
            vkey_hash: vkey_hash.clone(),
        };
        let ix = Instruction::new_with_borsh(
            program_id,
            &ix_data,
            vec![AccountMeta::new(payer.pubkey(), false)],
        );
        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], bh);
        tx
    };

    // positive: must verify
    let tx = make_tx(public_inputs.clone(), blockhash);
    let tx_bytes = bincode::serialize(&tx).unwrap().len();
    let outcome = banks.process_transaction_with_metadata(tx).await.unwrap();
    let verify_ok = outcome.result.is_ok();
    assert!(verify_ok, "on-chain verify FAILED: {:?}", outcome.result);
    println!("VERIFY_OK {}", verify_ok);
    println!("TX_BYTES {}", tx_bytes);

    // negative: flip one public-input byte -> must be rejected (non-vacuous pass)
    let mut tampered = public_inputs.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    let bh2 = banks.get_latest_blockhash().await.unwrap();
    let neg = banks.process_transaction_with_metadata(make_tx(tampered, bh2)).await.unwrap();
    let negative_rejected = neg.result.is_err();
    assert!(negative_rejected, "tampered proof was NOT rejected");
    println!("NEGATIVE_REJECTED {}", negative_rejected);

    let out = serde_json::json!({
        "sp1_sdk": "5.0.0",
        "sp1_zkvm": "5.0.0",
        "sp1_build": "5.0.0",
        "sp1_internal_crates": "5.2.4",
        "sp1_toolchain": "v5.0.0",
        "groth16_circuit": "v5.0.0",
        "sp1_solana": "0.1.0",
        "groth16_vk": "GROTH16_VK_5_0_0_BYTES",
        "solana_program": "2.1.6",
        "harness": "solana-program-test (native processor)",
        "vkey_hash": vkey_hash,
        "prove_ms": prove_ms,
        "proof_bytes": proof_bytes.len(),
        "public_inputs_bytes": public_inputs.len(),
        "tx_bytes": tx_bytes,
        "verify_ok": verify_ok,
        "negative_rejected": negative_rejected,
        "compute_units": "not metered (native processor); real CU via validator deploy — M2"
    });
    std::fs::write("m05-metrics.json", serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("wrote m05-metrics.json");
}
