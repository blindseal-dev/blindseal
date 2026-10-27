//! actionHash + nullifier vectors (canonical hashing spec). Deterministic layout; the TS SDK and
//! the Solana program must reproduce these exactly. Written to evals/vectors/action-hash.txt.
use blindseal_detector_core::{action_hash, nullifier, ActionFields, Commitments};

fn hex(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

#[test]
fn action_hash_and_nullifier_vector() {
    let a = ActionFields {
        chain_id: 1,
        target_program: [0x11; 32],
        source_authority: [0x22; 32],
        instruction: [0x02, 0, 0, 0, 0, 0, 0, 0],
        recipient: [0x33; 32],
        mint: [0x44; 32],
        amount: 1_000_000,
    };
    let c = Commitments {
        payload_hash: [0xaa; 32],
        policy_root: [0xbb; 32],
        detector_version: [0xcc; 32],
        expiry_slot: 280_000_000,
        nonce: [0xdd; 32],
    };
    let ah = action_hash(&a, &c);
    let nf = nullifier(&ah);

    assert_eq!(action_hash(&a, &c), ah, "deterministic");
    assert_ne!(ah, [0u8; 32]);
    assert_ne!(nf, ah, "nullifier distinct from action hash");

    // changing any field changes the hash
    let mut a2 = a;
    a2.amount = a.amount + 1;
    assert_ne!(action_hash(&a2, &c), ah, "amount is bound");
    let mut a3 = a;
    a3.source_authority = [0x23; 32];
    assert_ne!(action_hash(&a3, &c), ah, "source authority is bound");

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/action-hash.txt");
    std::fs::write(
        path,
        format!(
            "# Blindseal actionHash/nullifier vector (§3.3). TS SDK + Solana program must match.\nactionHash {}\nnullifier  {}\n",
            hex(&ah),
            hex(&nf)
        ),
    )
    .expect("write action-hash.txt");
    eprintln!("actionHash {} | nullifier {}", hex(&ah), hex(&nf));
}
