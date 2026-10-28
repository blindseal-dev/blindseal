//! Release 0.7.0 / audit finding #7: the GUEST refuses a payload that does not describe the action it
//! is asked to bind. Runs the committed guest ELF (or $BLINDSEAL_GUEST_ELF) in the SP1 executor
//! (`execute()` — real RISC-V execution of the guest, no proof) with the guest's stdin built exactly
//! as the prover builds it, and checks each mismatch halts with the guest's own refusal message.
//! The prover's host pre-check is bypassed on purpose: this is the in-zkVM assertion.
//!   cargo test --release --manifest-path crates/prover/Cargo.toml --test guest_binding
use blindseal_detector_core::action_binding::{GATED_TRANSFER_DISC, TRANSFER_GATE_ID};
use blindseal_detector_core::serialize_l1;
use sp1_sdk::{Prover, ProverClient, SP1Stdin};

const SRC: &str = "Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4";
const DST: &str = "7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24";
const OTHER: &str = "9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf";

fn pk(s: &str) -> [u8; 32] {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}

fn elf() -> Vec<u8> {
    let p = std::env::var("BLINDSEAL_GUEST_ELF")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../guest/elf/blindseal-guest").to_string());
    std::fs::read(&p).unwrap_or_else(|e| panic!("read guest ELF {p}: {e}"))
}

#[derive(Clone)]
struct Action {
    chain_id: u16,
    target: [u8; 32],
    source: [u8; 32],
    ix: [u8; 8],
    recipient: [u8; 32],
    mint: [u8; 32],
    amount: u64,
}

fn screened() -> (Vec<u8>, Action) {
    let payload = format!(r#"{{"tool":"transfer_sol","args":{{"to":"{DST}","lamports":1000000,"from":"{SRC}","memo":"invoice 2026-10 settlement"}}}}"#);
    let a = Action { chain_id: 1, target: TRANSFER_GATE_ID, source: pk(SRC), ix: GATED_TRANSFER_DISC, recipient: pk(DST), mint: [0; 32], amount: 1_000_000 };
    (payload.into_bytes(), a)
}

/// Execute the guest; Ok(cycles) if it halted cleanly, Err(guest stderr + error) if it refused.
fn execute(payload: &[u8], a: &Action) -> Result<u64, String> {
    let mut stdin = SP1Stdin::new();
    stdin.write(&payload.to_vec());
    stdin.write(&serialize_l1().dfas);
    stdin.write(&[7u8; 32]); // detectorVersion: a public input, not checked by the guest
    stdin.write(&a.chain_id);
    stdin.write(&a.target);
    stdin.write(&a.source);
    stdin.write(&a.ix);
    stdin.write(&a.recipient);
    stdin.write(&a.mint);
    stdin.write(&a.amount);
    stdin.write(&2_000_000_000u64);
    stdin.write(&[9u8; 32]);
    let client = ProverClient::builder().cpu().build();
    let mut err = Vec::new();
    let r = client.execute(&elf(), &stdin).stderr(&mut err).run();
    match r {
        Ok((_, report)) => Ok(report.total_instruction_count()),
        Err(e) => Err(format!("{}\n{e}", String::from_utf8_lossy(&err))),
    }
}

fn expect_refused(payload: &[u8], a: &Action, code: &str) {
    match execute(payload, a) {
        Ok(cycles) => panic!("guest ATTESTED a mismatched payload/action ({code}): halted cleanly after {cycles} cycles"),
        Err(msg) => assert!(
            msg.contains(&format!("payload/action binding refused: {code}")),
            "guest failed, but not with the binding refusal {code}:\n{msg}"
        ),
    }
}

#[test]
fn guest_refuses_mismatched_recipient() {
    let (p, mut a) = screened();
    a.recipient = pk(OTHER);
    expect_refused(&p, &a, "recipient-mismatch");
}

#[test]
fn guest_refuses_mismatched_amount() {
    let (p, mut a) = screened();
    a.amount = 2_000_000;
    expect_refused(&p, &a, "amount-mismatch");
}

#[test]
fn guest_refuses_mismatched_source_authority() {
    let (p, mut a) = screened();
    a.source = pk(OTHER);
    expect_refused(&p, &a, "source-authority-mismatch");
}

#[test]
fn guest_refuses_mismatched_target_program() {
    let (p, mut a) = screened();
    a.target = [0; 32]; // System Program
    expect_refused(&p, &a, "target-program-mismatch");
}

#[test]
fn guest_refuses_mismatched_instruction() {
    let (p, mut a) = screened();
    a.ix = [1, 2, 3, 4, 5, 6, 7, 8];
    expect_refused(&p, &a, "instruction-mismatch");
}

#[test]
fn guest_refuses_mismatched_mint() {
    let (p, mut a) = screened();
    a.mint = pk(OTHER);
    expect_refused(&p, &a, "mint-mismatch");
}

#[test]
fn guest_refuses_unparseable_payload() {
    let (_, a) = screened();
    expect_refused(b"transfer 1000000 lamports to 7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24 please", &a, "unparseable");
}

#[test]
fn guest_refuses_payload_that_is_not_an_action() {
    let (_, a) = screened();
    expect_refused(br#"{"tool":"read_file","args":{"path":"/etc/hosts"}}"#, &a, "not-an-action");
}

/// The f1fcab3 localnet fixture: its payload (tests/fixtures/payload-test.json) names a different
/// source and recipient than the action its proof binds — exactly the gap this release closes.
#[test]
fn guest_refuses_the_old_localnet_fixture_pairing() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let payload = std::fs::read_to_string(format!("{root}/tests/fixtures/payload-test.json")).unwrap();
    let (_, a) = screened(); // the fixture's action: seeded source → seeded recipient, 1_000_000
    expect_refused(payload.trim_end().as_bytes(), &a, "source-authority-mismatch");
}

/// The matching pair still attests (a full ~10^8-cycle run: L1 over every rule DFA).
#[test]
fn guest_attests_the_matching_payload() {
    let (p, a) = screened();
    let cycles = execute(&p, &a).unwrap_or_else(|e| panic!("guest refused a matching payload/action:\n{e}"));
    assert!(cycles > 0);
}

/// The prover binary checks the same binding on the host before setup and exits 3 with the reason
/// (BLINDSEAL_EXECUTE=1 so a prover without the check executes and exits 0 instead of proving for hours).
#[test]
fn prover_cli_refuses_mismatch_before_setup() {
    let dir = std::env::temp_dir().join(format!("bs-prover-bind-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let payload = dir.join("payload.json");
    std::fs::write(&payload, screened().0).unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_blindseal-prover"))
        .env("BLINDSEAL_EXECUTE", "1")
        .args(["--payload", payload.to_str().unwrap(), "--out", dir.join("att.json").to_str().unwrap()])
        .args(["--target-program", "9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa", "--source-authority", SRC])
        .args(["--recipient", OTHER, "--amount", "1000000", "--instruction", "0x981894646560fc2b", "--expiry", "2000000000"])
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(3), "prover did not refuse; stderr:\n{stderr}");
    assert!(stderr.contains("payload/action binding refused: recipient-mismatch"), "{stderr}");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("VKEY"), "refusal must come before setup");
}
