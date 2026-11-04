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
//! Before anything is set up the payload/action binding the guest asserts (detector-core
//! `check_action_binding`) is checked here too, so a mismatched pair fails in milliseconds with the
//! reason instead of panicking inside the zkVM.
//!
//! `--mode cpu|cuda|network` (env `BLINDSEAL_PROVER_MODE` as the fallback; default cpu) picks where the
//! proof is made. `cpu` and `cuda` are local: the payload never leaves the machine. `cuda` needs the
//! `cuda` Cargo feature and a Moongate GPU prover server (sp1-cuda starts one through docker, or
//! `BLINDSEAL_MOONGATE_URL` names a running one). `network` needs the `network` Cargo feature, the env
//! `BLINDSEAL_NETWORK_ACKNOWLEDGED=1` and `NETWORK_PRIVATE_KEY`: the payload and the policy are sent to the
//! Succinct prover network, which is why it is never the default and never picked by an env var alone.
//! The attestation records the mode under `prover: { mode, host, version }`.
//!
//! `BLINDSEAL_EXECUTE=1` runs the zkVM executor (cycle count, no proof) for fast iteration.
//! `--policy-variant one-rule-copied` is a TEST-ONLY probe: the default policy with rule 0's DFA
//! replaced by a copy of rule 1's, so the proof commits a different policyRoot (the localnet
//! "alternate policy" fixture). Never use it for a real attestation.
use blindseal_detector_core::{check_action_binding, serialize_l1, ActionFields};
use sp1_sdk::{utils, HashableKey, Prover, ProverClient, SP1ProofMode, SP1Stdin};
use std::time::Instant;

const GUEST_ELF: &[u8] = include_bytes!("../../guest/elf/blindseal-guest");

const USAGE: &str = "blindseal-prover --payload <file> --out <attestation.json>
  --target-program <base58> --source-authority <base58> --recipient <base58>
  [--mint <base58>] --amount <u64> --instruction <16 hex> [--expiry <slot>]
  [--nonce <64 hex>] [--chain-id <u16>] [--decision-id <id>]
  [--mode cpu|cuda|network]            (default cpu, or $BLINDSEAL_PROVER_MODE)
  [--policy-variant one-rule-copied]   (test-only alternate policy)";

/// Where the proof is made. Only `Network` sends the payload off the machine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Cpu,
    Cuda,
    Network,
}

impl Mode {
    fn parse(s: &str) -> Option<Mode> {
        match s {
            "cpu" => Some(Mode::Cpu),
            "cuda" => Some(Mode::Cuda),
            "network" => Some(Mode::Network),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Mode::Cpu => "cpu",
            Mode::Cuda => "cuda",
            Mode::Network => "network",
        }
    }
}

/// The three sp1-sdk client types behind one surface. Each implements `sp1_sdk::Prover`; the trait
/// methods are named explicitly because `CpuProver`/`CudaProver` also have inherent builder methods
/// of the same names.
enum Client {
    Cpu(sp1_sdk::CpuProver),
    #[cfg(feature = "cuda")]
    Cuda(sp1_sdk::CudaProver),
    #[cfg(feature = "network")]
    Network(sp1_sdk::NetworkProver),
}

impl Client {
    fn setup(&self, elf: &[u8]) -> (sp1_sdk::SP1ProvingKey, sp1_sdk::SP1VerifyingKey) {
        match self {
            Client::Cpu(p) => Prover::setup(p, elf),
            #[cfg(feature = "cuda")]
            Client::Cuda(p) => Prover::setup(p, elf),
            #[cfg(feature = "network")]
            Client::Network(p) => Prover::setup(p, elf),
        }
    }
    fn execute(&self, elf: &[u8], stdin: &SP1Stdin) -> anyhow::Result<(sp1_sdk::SP1PublicValues, sp1_sdk::ExecutionReport)> {
        match self {
            Client::Cpu(p) => Prover::execute(p, elf, stdin),
            #[cfg(feature = "cuda")]
            Client::Cuda(p) => Prover::execute(p, elf, stdin),
            #[cfg(feature = "network")]
            Client::Network(p) => Prover::execute(p, elf, stdin),
        }
    }
    fn prove_groth16(&self, pk: &sp1_sdk::SP1ProvingKey, stdin: &SP1Stdin) -> anyhow::Result<sp1_sdk::SP1ProofWithPublicValues> {
        match self {
            Client::Cpu(p) => Prover::prove(p, pk, stdin, SP1ProofMode::Groth16),
            #[cfg(feature = "cuda")]
            Client::Cuda(p) => Prover::prove(p, pk, stdin, SP1ProofMode::Groth16),
            #[cfg(feature = "network")]
            Client::Network(p) => Prover::prove(p, pk, stdin, SP1ProofMode::Groth16),
        }
    }
}

/// Builds the client for `mode`, or exits 4 with the reason (feature not compiled in, acknowledgement
/// or key missing). Printing happens here so every refusal is one line on stderr.
fn build_client(mode: Mode) -> Client {
    match mode {
        Mode::Cpu => Client::Cpu(ProverClient::builder().cpu().build()),
        Mode::Cuda => {
            #[cfg(feature = "cuda")]
            {
                // BLINDSEAL_MOONGATE_URL: a Moongate server that is already running (a sidecar, or one
                // started by the entrypoint of Dockerfile.cuda). Without it sp1-cuda starts the GPU
                // server container itself through docker (image $SP1_GPU_IMAGE or its default).
                match std::env::var("BLINDSEAL_MOONGATE_URL") {
                    Ok(url) if !url.is_empty() => {
                        eprintln!("blindseal-prover: mode cuda, Moongate server at {url}");
                        Client::Cuda(ProverClient::builder().cuda().server(&url).build())
                    }
                    _ => {
                        eprintln!("blindseal-prover: mode cuda, starting the Moongate server through docker");
                        Client::Cuda(ProverClient::builder().cuda().build())
                    }
                }
            }
            #[cfg(not(feature = "cuda"))]
            {
                eprintln!("blindseal-prover: --mode cuda needs a binary built with --features cuda (cargo build --release --features cuda)");
                std::process::exit(4);
            }
        }
        Mode::Network => {
            #[cfg(feature = "network")]
            {
                if std::env::var("BLINDSEAL_NETWORK_ACKNOWLEDGED").map(|v| v != "1").unwrap_or(true) {
                    eprintln!("blindseal-prover: --mode network sends the payload (the screened tool call) and the policy to the Succinct prover network; set BLINDSEAL_NETWORK_ACKNOWLEDGED=1 to confirm that is intended");
                    std::process::exit(4);
                }
                if std::env::var("NETWORK_PRIVATE_KEY").map(|v| v.is_empty()).unwrap_or(true) {
                    eprintln!("blindseal-prover: --mode network needs NETWORK_PRIVATE_KEY (the prover network account's secp256k1 key, hex; sp1-sdk reads it); NETWORK_RPC_URL overrides the default endpoint");
                    std::process::exit(4);
                }
                eprintln!("blindseal-prover: WARNING mode network: the payload and the policy leave this machine for the Succinct prover network; the proof is not private to this host");
                Client::Network(ProverClient::builder().network().build())
            }
            #[cfg(not(feature = "network"))]
            {
                eprintln!("blindseal-prover: --mode network needs a binary built with --features network (cargo build --release --features network)");
                std::process::exit(4);
            }
        }
    }
}

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
    policy_variant: Option<String>,
    mode: Mode,
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
        policy_variant: get("--policy-variant"),
        mode: {
            let raw = get("--mode").or_else(|| std::env::var("BLINDSEAL_PROVER_MODE").ok().filter(|v| !v.is_empty()));
            match raw {
                None => Mode::Cpu,
                Some(m) => Mode::parse(&m).unwrap_or_else(|| panic!("unknown --mode {m} (cpu, cuda or network)\n{USAGE}")),
            }
        },
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

    // The guest's step 0, on the host first: refuse a payload that does not describe this action.
    let action = ActionFields {
        chain_id: args.chain_id,
        target_program: pk32(&args.target_program),
        source_authority: pk32(&args.source_authority),
        instruction: args.instruction,
        recipient: pk32(&args.recipient),
        mint: pk32(&args.mint),
        amount: args.amount,
    };
    if let Err(e) = check_action_binding(&args.payload, &action) {
        eprintln!("blindseal-prover: payload/action binding refused: {} — the payload does not describe this action; no proof", e.code());
        std::process::exit(3);
    }

    let client = build_client(args.mode);
    let (pk, vk) = client.setup(GUEST_ELF);
    let vkey = vk.bytes32();
    let detector_version = hex_to_32(&vkey);
    println!("VKEY {vkey}");

    let mut dfas = serialize_l1().dfas;
    match args.policy_variant.as_deref() {
        None => {}
        Some("one-rule-copied") => {
            eprintln!("blindseal-prover: TEST-ONLY policy variant one-rule-copied (rule 0 DFA := rule 1 DFA)");
            dfas[0] = dfas[1].clone();
        }
        Some(v) => panic!("unknown --policy-variant {v}"),
    }
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
        let (mut pv, report) = client.execute(GUEST_ELF, &stdin).expect("execute failed");
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
    let proof = client.prove_groth16(&pk, &stdin).expect("groth16 prove failed");
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
        // Where the proof was made. host: "local" unless the operator says otherwise
        // (BLINDSEAL_PROVER_HOST=vast, set by the hosted prover's Vast backend); network mode is "network".
        "prover": {
            "mode": args.mode.name(),
            "host": if args.mode == Mode::Network { "network".to_string() } else { std::env::var("BLINDSEAL_PROVER_HOST").ok().filter(|h| h == "local" || h == "vast").unwrap_or_else(|| "local".to_string()) },
            "version": env!("CARGO_PKG_VERSION"),
        },
        "note": "L1-only screening (L0 decode-then-L1 in-guest is the next increment)"
    });
    std::fs::write(&args.out, serde_json::to_string_pretty(&att).unwrap()).unwrap();
    println!("PROVE_MS {prove_ms}");
    println!("wrote {}", args.out);
}
