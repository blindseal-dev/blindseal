//! The guest's payload → action binding reproduces every shared vector (evals/vectors/action-binding.json,
//! generated from the proxy's TypeScript mirror): host attest and the guest agree on what a payload binds.
use blindseal_detector_core::action_binding::action_from_payload;

fn b58(b: &[u8; 32]) -> String {
    bs58::encode(b).into_string()
}

#[test]
fn rust_binding_matches_shared_vectors() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/action-binding.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let vectors = v["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 50);
    let mut failures = Vec::new();
    for c in vectors {
        let name = c["name"].as_str().unwrap();
        let got = action_from_payload(c["payload"].as_str().unwrap().as_bytes());
        match (&got, c.get("error").and_then(|e| e.as_str())) {
            (Err(e), Some(want)) if e.code() == want => {}
            (Ok(a), None) => {
                let w = &c["action"];
                let ix = format!("0x{}", a.instruction.iter().map(|b| format!("{b:02x}")).collect::<String>());
                let same = w["chainId"].as_u64() == Some(a.chain_id as u64)
                    && w["targetProgram"].as_str() == Some(&b58(&a.target_program))
                    && w["instruction"].as_str() == Some(&ix)
                    && w["sourceAuthority"].as_str() == Some(&b58(&a.source_authority))
                    && w["recipient"].as_str() == Some(&b58(&a.recipient))
                    && w["mint"].as_str() == Some(&b58(&a.mint))
                    && w["amount"].as_str() == Some(&a.amount.to_string());
                if !same {
                    failures.push(format!("{name}: rust {a:?} vs vector {w}"));
                }
            }
            _ => failures.push(format!("{name}: rust {:?} vs vector {}", got.map(|_| "ok").map_err(|e| e.code()), c.get("error").map(|e| e.to_string()).unwrap_or("ok".into()))),
        }
    }
    assert!(failures.is_empty(), "{} disagreements:\n{}", failures.len(), failures.join("\n"));
}
