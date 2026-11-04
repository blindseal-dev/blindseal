//! Host tests for the 0.8.0 Config layout: a pre-0.8.0 account (303 bytes, no fee fields) must read as
//! fee 0 / no treasury, the new account size is what the SDK and the release plan state, and the
//! `set_fee` instruction data is what the SDK's hand encoder produces.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::{AccountDeserialize, Discriminator, InstructionData};
use blindseal_verify::{instruction, Config, MAX_VKEYS};

/// Config written by the 0.7.x program: 8 disc ‖ 32 authority ‖ vec<[u8;32]> ‖ bool ‖ bool ‖ u8, in a
/// fixed 303-byte account (max_len 8 vkeys), zero behind the written bytes.
fn legacy_config_bytes(authority: Pubkey, vkeys: &[[u8; 32]]) -> Vec<u8> {
    let mut b = Vec::with_capacity(303);
    b.extend_from_slice(Config::DISCRIMINATOR);
    b.extend_from_slice(authority.as_ref());
    b.extend_from_slice(&(vkeys.len() as u32).to_le_bytes());
    for k in vkeys {
        b.extend_from_slice(k);
    }
    b.push(1); // allowlist_policies
    b.push(0); // paused
    b.push(253); // bump
    b.resize(303, 0);
    b
}

#[test]
fn sizes_are_the_documented_ones() {
    // 32 + (4 + 8*32) + 1 + 1 + 1 = 295 before 0.8.0; + 8 + 32 = 335 now; both + the 8-byte discriminator
    assert_eq!(8 + Config::INIT_SPACE, 343);
    assert_eq!(8 + Config::INIT_SPACE - 8 - 32, 303);
}

#[test]
fn a_pre_fee_config_reads_as_fee_zero_and_no_treasury() {
    let authority = Pubkey::new_unique();
    let vkeys = [[7u8; 32], [9u8; 32]]; // mainnet holds two
    let data = legacy_config_bytes(authority, &vkeys);
    let c = Config::try_deserialize(&mut &data[..]).expect("legacy layout deserializes");
    assert_eq!(c.authority, authority);
    assert_eq!(c.allowed_vkeys, vkeys.to_vec());
    assert!(c.allowlist_policies);
    assert!(!c.paused);
    assert_eq!(c.bump, 253);
    assert_eq!(c.fee_lamports, 0);
    assert_eq!(c.treasury, Pubkey::default());
}

#[test]
fn the_legacy_read_holds_up_to_six_vkeys_and_the_new_struct_fits_the_new_size() {
    // 6 vkeys leave 64 bytes of padding (≥ 40); 7 leave 32 and the read fails — the upgrade must land
    // with at most 6 vkeys allowed (docs/release-0.8.0-fee-switch.md).
    let six = vec![[1u8; 32]; 6];
    assert!(Config::try_deserialize(&mut &legacy_config_bytes(Pubkey::new_unique(), &six)[..]).is_ok());
    let seven = vec![[1u8; 32]; 7];
    assert!(Config::try_deserialize(&mut &legacy_config_bytes(Pubkey::new_unique(), &seven)[..]).is_err());

    let full = Config {
        authority: Pubkey::new_unique(),
        allowed_vkeys: vec![[2u8; 32]; MAX_VKEYS],
        allowlist_policies: true,
        paused: true,
        bump: 1,
        fee_lamports: u64::MAX,
        treasury: Pubkey::new_unique(),
    };
    let mut out = Vec::new();
    full.try_serialize(&mut out).unwrap();
    assert_eq!(out.len(), 8 + Config::INIT_SPACE, "8 vkeys + fee fields fill the account exactly");
    let back = Config::try_deserialize(&mut &out[..]).unwrap();
    assert_eq!(back.fee_lamports, u64::MAX);
    assert_eq!(back.treasury, full.treasury);
}

#[test]
fn set_fee_instruction_data_is_disc_u64le_pubkey() {
    let treasury = Pubkey::new_unique();
    let data = instruction::SetFee { fee_lamports: 12_345, treasury }.data();
    let disc = &hash(b"global:set_fee").to_bytes()[..8];
    assert_eq!(&data[..8], disc);
    assert_eq!(&data[8..16], &12_345u64.to_le_bytes());
    assert_eq!(&data[16..48], treasury.as_ref());
    assert_eq!(data.len(), 48);
}
