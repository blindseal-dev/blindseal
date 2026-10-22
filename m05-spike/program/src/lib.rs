//! Blindseal M0.5 spike verifier: confirm sp1-solana verifies an SP1 v5 Groth16 proof on
//! the Solana runtime (alt_bn128 syscalls). The real programs/blindseal-verify (M2) pins
//! the vkey via an allowlist; here the host passes it so a local (non-docker) guest build
//! works without a two-phase build. See DECISIONS.md.
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, msg, program_error::ProgramError,
    pubkey::Pubkey,
};
use sp1_solana::verify_proof;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[derive(BorshDeserialize, BorshSerialize)]
pub struct SP1Groth16Proof {
    pub proof: Vec<u8>,
    pub sp1_public_inputs: Vec<u8>,
    pub vkey_hash: String,
}

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let p = SP1Groth16Proof::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let vk = sp1_solana::GROTH16_VK_5_0_0_BYTES;
    verify_proof(&p.proof, &p.sp1_public_inputs, &p.vkey_hash, vk)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    msg!("sp1-solana: SP1 v5 Groth16 proof VERIFIED on-chain");
    Ok(())
}
