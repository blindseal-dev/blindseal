//! Action-policy parity (release 0.8.0): the Rust `ActionPolicy` (what the guest checks and hashes) must
//! reproduce every vector the SDK's TypeScript computed in evals/vectors/action-policy.json — the
//! canonical actionPolicyHash, the v2 policy root over the committed rules root, and the check outcome
//! for each action. Also asserts the rules root the vectors use IS the committed rules root. Regenerate
//! with evals/action-policy/generate.ts.
use blindseal_detector_core::{policy_root, policy_root_v2, ActionFields, ActionPolicy};
use serde_json::Value;

fn pk(s: &str) -> [u8; 32] {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}
fn hex(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}
fn h8(s: &str) -> [u8; 8] {
    let h = s.trim_start_matches("0x");
    let mut o = [0u8; 8];
    for i in 0..8 {
        o[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
    o
}
fn keys(v: &Value) -> Vec<[u8; 32]> {
    v.as_array().map(|a| a.iter().map(|x| pk(x.as_str().unwrap())).collect()).unwrap_or_default()
}

fn policy(j: &Value) -> ActionPolicy {
    ActionPolicy {
        recipients: keys(&j["recipients"]),
        max_amount: match &j["maxAmount"] {
            Value::String(s) => Some(s.parse().unwrap()),
            Value::Number(n) => Some(n.as_u64().unwrap()),
            _ => None,
        },
        target_programs: keys(&j["targetPrograms"]),
        instructions: j["instructions"].as_array().map(|a| a.iter().map(|x| h8(x.as_str().unwrap())).collect()).unwrap_or_default(),
        mints: keys(&j["mints"]),
    }
}

#[test]
fn action_policy_parity_with_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/action-policy.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("read action-policy.json")).unwrap();
    let rules_root_hex = v["rulesRoot"].as_str().unwrap();
    assert_eq!(rules_root_hex, hex(&policy_root()), "the vectors' rules root must be the committed rules root");
    let rules_root = policy_root();
    for p in v["policies"].as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        let pol = policy(&p["policy"]);
        assert_eq!(hex(&pol.hash()), p["actionPolicyHash"].as_str().unwrap(), "[{id}] actionPolicyHash");
        assert_eq!(hex(&policy_root_v2(&rules_root, &pol.hash())), p["policyRoot"].as_str().unwrap(), "[{id}] policyRoot");
        for (aid, want) in p["checks"].as_object().unwrap() {
            let a = &v["actions"][aid];
            let act = ActionFields {
                chain_id: 1,
                target_program: pk(a["targetProgram"].as_str().unwrap()),
                source_authority: [0; 32],
                instruction: h8(a["instruction"].as_str().unwrap()),
                recipient: pk(a["recipient"].as_str().unwrap()),
                mint: pk(a["mint"].as_str().unwrap()),
                amount: a["amount"].as_str().unwrap().parse().unwrap(),
            };
            let got = pol.canonical().check(&act).map(|_| "ok").unwrap_or_else(|e| e.code());
            assert_eq!(got, want.as_str().unwrap(), "[{id} × {aid}] check");
        }
    }
}
