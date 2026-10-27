//! TEST-ONLY forwarder (see Cargo.toml). Native, not Anchor: Anchor's entrypoint rejects any id
//! other than its `declare_id!`, and this program runs at an id generated at test time.
//!
//! accounts[0] = the program to call; accounts[1..] = its accounts (signer / writable flags kept);
//! instruction data = passed through unchanged. Pointing accounts[0] at this program itself nests
//! one level deeper (rogue → rogue → target).
use anchor_lang::solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process_instruction);

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, rest) = accounts.split_first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas = rest
        .iter()
        .map(|a| if a.is_writable { AccountMeta::new(*a.key, a.is_signer) } else { AccountMeta::new_readonly(*a.key, a.is_signer) })
        .collect();
    invoke(&Instruction { program_id: *target.key, accounts: metas, data: data.to_vec() }, accounts)
}
