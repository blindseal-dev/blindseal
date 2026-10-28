//! The vkey the SDK pins as CURRENT_VKEY (packages/sdk/src/ix.ts — what init scripts allowlist and
//! what the staged mainnet upgrade adds) is the vkey of the committed guest ELF, which the prover
//! embeds. A guest rebuild without re-pinning fails here.
use sp1_sdk::{HashableKey, Prover, ProverClient};

#[test]
fn sdk_current_vkey_is_the_committed_guest_elf_vkey() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let elf = std::fs::read(format!("{root}/crates/guest/elf/blindseal-guest")).unwrap();
    let ix = std::fs::read_to_string(format!("{root}/packages/sdk/src/ix.ts")).unwrap();
    let pinned = ix
        .lines()
        .find_map(|l| l.strip_prefix("export const CURRENT_VKEY = '"))
        .and_then(|r| r.split('\'').next())
        .expect("CURRENT_VKEY in packages/sdk/src/ix.ts");
    let client = ProverClient::builder().cpu().build();
    let (_, vk) = client.setup(&elf);
    assert_eq!(vk.bytes32(), pinned, "committed guest ELF vkey != SDK CURRENT_VKEY");
}
