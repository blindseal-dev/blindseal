//! M0.5 localnet verify: deploy blindseal-m05-program to a running solana-test-validator and send
//! the SP1 v5 Groth16 verify instruction with the real proof, recording real CU + tx size. Groth16
//! verification (alt_bn128 pairings) needs a raised compute-unit limit. Arg: <program_id>.
use blindseal_m05_program::SP1Groth16Proof;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig, compute_budget::ComputeBudgetInstruction,
    instruction::Instruction, pubkey::Pubkey, signature::{read_keypair_file, Signer},
    transaction::Transaction,
};
use sp1_sdk::SP1ProofWithPublicValues;
use std::str::FromStr;

const CU_LIMIT: u32 = 1_400_000; // max per-ix budget; the verify's real usage is measured below

fn main() {
    let program_id = Pubkey::from_str(&std::env::args().nth(1).expect("usage: m05-localnet <program_id>")).expect("bad program id");
    let metrics: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("m05-metrics.json").expect("m05-metrics.json")).unwrap();
    let vkey_hash = metrics["vkey_hash"].as_str().expect("vkey_hash").to_string();

    let proof = SP1ProofWithPublicValues::load("m05_proof.bin").expect("load m05_proof.bin");
    let proof_bytes = proof.bytes();
    let public_inputs = proof.public_values.to_vec();

    let rpc = RpcClient::new_with_commitment("http://127.0.0.1:8899".to_string(), CommitmentConfig::confirmed());
    let payer = read_keypair_file(format!("{}/.config/solana/id.json", std::env::var("HOME").unwrap())).expect("payer keypair");

    let build = |pub_in: Vec<u8>| {
        let data = SP1Groth16Proof { proof: proof_bytes.clone(), sp1_public_inputs: pub_in, vkey_hash: vkey_hash.clone() };
        let verify_ix = Instruction::new_with_borsh(program_id, &data, vec![]);
        let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(CU_LIMIT);
        let bh = rpc.get_latest_blockhash().expect("blockhash");
        Transaction::new_signed_with_payer(&[budget_ix, verify_ix], Some(&payer.pubkey()), &[&payer], bh)
    };

    let tx = build(public_inputs.clone());
    let tx_bytes = bincode::serialize(&tx).unwrap().len();
    let sim = rpc.simulate_transaction(&tx).expect("simulate");
    assert!(sim.value.err.is_none(), "verify simulation failed: {:?} logs={:?}", sim.value.err, sim.value.logs);
    let cu = sim.value.units_consumed.unwrap_or(0);
    let sig = rpc.send_and_confirm_transaction(&tx).expect("verify tx must land on localnet");
    println!("VERIFY_OK sig={sig}");
    println!("COMPUTE_UNITS {cu}");
    println!("TX_BYTES {tx_bytes}");

    let mut tampered = public_inputs.clone();
    tampered[0] ^= 0x01;
    let neg_sim = rpc.simulate_transaction(&build(tampered)).expect("simulate neg");
    let negative_rejected = neg_sim.value.err.is_some();
    println!("NEGATIVE_REJECTED {negative_rejected}");
    assert!(negative_rejected, "tampered proof must be rejected");

    let out = serde_json::json!({
        "harness": "solana-test-validator (localnet, SBF VM)", "program_id": program_id.to_string(),
        "verify_ok": true, "negative_rejected": negative_rejected,
        "compute_units": cu, "compute_unit_limit_requested": CU_LIMIT, "tx_bytes": tx_bytes,
        "proof_bytes": proof_bytes.len(), "public_inputs_bytes": public_inputs.len(), "vkey_hash": vkey_hash,
        "groth16_vk": "GROTH16_VK_5_0_0_BYTES", "sp1_sdk": "5.0.0", "sp1_zkvm": "5.0.0", "sp1_solana": "0.1.0", "solana": "2.1.6",
    });
    std::fs::write("m05-localnet-metrics.json", serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("wrote m05-localnet-metrics.json");
}
