//! Blindseal example gated program: a BATCH of SPL token payouts that executes only if EVERY payout
//! carries a Blindseal attestation for exactly that payout, verified and consumed in the same
//! transaction. One failing payout (bad proof, wrong field, replayed nullifier, failed transfer)
//! reverts the whole batch, so no nullifier is consumed and no token moves.
//!
//! Per payout the action forwarded to blindseal-verify is built from what this program is about to
//! execute, never from the agent's data: `source_authority` = the signing payer, `recipient` = the
//! OWNER of the destination token account (the person paid, not the token account address), `mint` =
//! the batch's mint, `amount` = the transfer amount, plus this program's id and `batch_payout`'s
//! discriminator. The verifier accepts the CPI only from the attestation's target program, so an
//! attestation screened for another program (transfer-gate's native transfer, say) fails here with
//! `ActionHashMismatch`.
//!
//! Why attestations are STAGED first: a Groth16 proof is 260 bytes and the committed public inputs
//! 168; two of them plus the account keys do not fit in one 1232-byte Solana transaction, so a batch
//! of inline proofs could never hold more than one payout. Instead the payer writes each attestation
//! into a small PDA (`stage_attestation`, one transaction each, any time before the batch), and
//! `batch_payout` reads them from accounts: per payout it needs only the nonce and amount as data and
//! three accounts (staged attestation, destination token account, nullifier PDA). The staged account
//! is closed back to the payer in the same batch, and `cancel_stage` returns the rent for an
//! attestation that is never used. Staging binds nothing: the verifier still recomputes the action
//! from this program's accounts, so a staged proof is as inert as a proof on disk.
//!
//! Policy: before each CPI the gate checks that the attestation's committed policy root is one IT
//! expects (`EXPECTED_POLICY_ROOTS`), else `UnexpectedPolicyRoot` — the same integrator-side check as
//! transfer-gate.
//!
//! Compute: one verify_and_consume is about 270k CU (docs/performance.md), so a batch is bounded by
//! the 1.4M CU transaction limit at roughly four payouts; the program does not cap it.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use blindseal_verify::program::BlindsealVerify;
use blindseal_verify::{cpi::accounts::VerifyAndConsume, ActionArgs, PUBLIC_INPUTS_LEN};

declare_id!("EPgeMVvpCDaCGoav5NDFBySPTxASBQfVEvaUY6KPKL4k");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Blindseal payout-gate (example consumer)",
    project_url: "https://blindseal.tech",
    contacts: "email:blindseal@proton.me",
    policy: "https://blindseal.tech/.well-known/security.txt",
    preferred_languages: "en",
    source_code: "https://github.com/blindseal-dev/blindseal"
}

pub const CHAIN_ID_SOLANA_MAINNET: u16 = 1;

/// The 0.8.0 default policy root (v2: the committed L1 rules, empty action policy) — same constant as transfer-gate.
pub const DEFAULT_POLICY_ROOT: [u8; 32] = [
    0x78, 0xbb, 0x3b, 0xab, 0x17, 0x65, 0x30, 0x43, 0x73, 0xa6, 0xaf, 0x9d, 0xe2, 0xd7, 0xc0, 0x81,
    0xce, 0x57, 0xbc, 0x86, 0x2c, 0x03, 0x9f, 0x6d, 0xd6, 0x82, 0xc7, 0x4e, 0x93, 0x9e, 0xb1, 0x0a,
];
/// The 0.7 policy root (the bare L1 rules root); the localnet payout fixtures were proven under it.
pub const LEGACY_POLICY_ROOT: [u8; 32] = [
    0x36, 0xa9, 0xe9, 0x45, 0x7d, 0xb6, 0xec, 0xfd, 0x75, 0x2a, 0x37, 0x9f, 0xc9, 0x27, 0x9a, 0xd6,
    0xa0, 0xac, 0xfe, 0xa0, 0x79, 0x28, 0xf6, 0x1e, 0x2f, 0x36, 0x38, 0xa6, 0x85, 0xc3, 0x83, 0x97,
];
pub const EXPECTED_POLICY_ROOTS: &[[u8; 32]] = &[DEFAULT_POLICY_ROOT, LEGACY_POLICY_ROOT];

pub const STAGED_SEED: &[u8] = b"staged";
/// Upper bound on a staged proof (a Groth16 proof as sp1-solana expects it is 260 bytes).
pub const MAX_PROOF_LEN: usize = 1024;
/// Accounts in `remaining_accounts` per payout: staged attestation, destination token account, nullifier PDA.
pub const ACCOUNTS_PER_PAYOUT: usize = 3;

/// The SPL Token program. Token-2022 accounts are refused: the layout below is the classic one.
pub const SPL_TOKEN_ID: Pubkey = anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Classic SPL token account: mint[0..32] ‖ owner[32..64] ‖ amount[64..72] ‖ … ‖ state[108] ‖ … (165 bytes).
const TOKEN_ACCOUNT_LEN: usize = 165;
const TOKEN_STATE_INITIALIZED: u8 = 1;
/// spl-token `Transfer` instruction tag (amount follows as u64 LE).
const TOKEN_IX_TRANSFER: u8 = 3;

#[program]
pub mod payout_gate {
    use super::*;

    /// Write one attestation into PDA(["staged", payer, nullifier]) for a later `batch_payout`. The
    /// payer pays the rent and gets it back when the batch closes the account (or via `cancel_stage`).
    /// Nothing is verified here on purpose: the verifier does every check at payout time against the
    /// payout actually executed.
    pub fn stage_attestation(ctx: Context<StageAttestation>, proof: Vec<u8>, public_inputs: Vec<u8>, nullifier: [u8; 32]) -> Result<()> {
        require!(public_inputs.len() == PUBLIC_INPUTS_LEN, GateError::BadPublicInputs);
        require!(proof.len() <= MAX_PROOF_LEN, GateError::ProofTooLong);
        // the seed must be the committed nullifier, so one staged slot per attestation per payer
        require!(public_inputs[128..160] == nullifier, GateError::NullifierSeedMismatch);
        let s = &mut ctx.accounts.staged;
        s.payer = ctx.accounts.payer.key();
        s.proof = proof;
        s.public_inputs = public_inputs;
        s.bump = ctx.bumps.staged;
        Ok(())
    }

    /// Close a staged attestation and return its rent to the payer who staged it.
    pub fn cancel_stage(_ctx: Context<CancelStage>) -> Result<()> {
        Ok(())
    }

    /// Execute `payouts.len()` SPL token transfers from `source_token` (owned by `payer`), each gated
    /// by the staged attestation passed for it. `remaining_accounts` holds, per payout in order:
    /// `[staged, recipient_token, nullifier]`.
    pub fn batch_payout<'info>(ctx: Context<'_, '_, 'info, 'info, BatchPayout<'info>>, payouts: Vec<PayoutArgs>) -> Result<()> {
        require!(!payouts.is_empty(), GateError::EmptyBatch);
        let rem = ctx.remaining_accounts;
        require!(rem.len() == payouts.len() * ACCOUNTS_PER_PAYOUT, GateError::WrongAccountCount);

        let payer = ctx.accounts.payer.key();
        let mint = ctx.accounts.mint.key();
        // the source: a classic token account for this mint whose owner is the signing payer
        let source_owner = token_account_owner(&ctx.accounts.source_token, &mint)?;
        require_keys_eq!(source_owner, payer, GateError::SourceNotPayers);

        let disc: [u8; 8] = <crate::instruction::BatchPayout as anchor_lang::Discriminator>::DISCRIMINATOR
            .try_into()
            .expect("8-byte discriminator");

        // Staged accounts are closed after the loop: closing one moves its rent to the payer, and a lamport
        // change to the payer between two verify_and_consume CPIs fails the next CPI (UnbalancedInstruction).
        let mut spent: Vec<Account<'info, Staged>> = Vec::with_capacity(payouts.len());
        for (i, p) in payouts.iter().enumerate() {
            let staged_info = &rem[i * ACCOUNTS_PER_PAYOUT];
            let dest_info = &rem[i * ACCOUNTS_PER_PAYOUT + 1];
            let nullifier_info = &rem[i * ACCOUNTS_PER_PAYOUT + 2];

            // 0) the staged attestation: owned by this program (discriminator checked), staged by this payer,
            //    screened under a policy this gate expects.
            let staged = Account::<Staged>::try_from(staged_info)?;
            require_keys_eq!(staged.payer, payer, GateError::StagedNotPayers);
            require!(staged.public_inputs.len() == PUBLIC_INPUTS_LEN, GateError::BadPublicInputs);
            let policy_root: [u8; 32] = staged.public_inputs[32..64].try_into().unwrap();
            require!(EXPECTED_POLICY_ROOTS.contains(&policy_root), GateError::UnexpectedPolicyRoot);

            // The action we are about to execute — from OUR accounts and args. The recipient the
            // attestation must name is the destination token account's OWNER.
            let recipient = token_account_owner(dest_info, &mint)?;
            let action = ActionArgs {
                chain_id: CHAIN_ID_SOLANA_MAINNET,
                target_program: crate::ID,
                source_authority: payer,
                instruction: disc,
                recipient,
                mint,
                amount: p.amount,
                nonce: p.nonce,
            };

            // 1) verify + consume this payout's nullifier (any failure reverts the whole batch).
            let cpi_accounts = VerifyAndConsume {
                config: ctx.accounts.config.to_account_info(),
                policy_root: ctx.accounts.policy_root.as_ref().map(|a| a.to_account_info()),
                nullifier: nullifier_info.clone(),
                payer: ctx.accounts.payer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                instructions: ctx.accounts.instructions.to_account_info(),
                // 0.8.0 fee accounts: the payer pays any fee; no treasury is forwarded, so batches work while
                // the verifier's fee is 0 and fail FeeAccountsMissing if the operator sets one.
                fee_payer: Some(ctx.accounts.payer.to_account_info()),
                treasury: None,
            };
            blindseal_verify::cpi::verify_and_consume(
                CpiContext::new(ctx.accounts.verify_program.to_account_info(), cpi_accounts),
                staged.proof.clone(),
                staged.public_inputs.clone(),
                action,
            )?;

            // 2) the screened transfer: spl-token Transfer(amount), source → destination, payer signs.
            let ix = Instruction {
                program_id: SPL_TOKEN_ID,
                accounts: vec![
                    AccountMeta::new(ctx.accounts.source_token.key(), false),
                    AccountMeta::new(dest_info.key(), false),
                    AccountMeta::new_readonly(payer, true),
                ],
                data: transfer_data(p.amount).to_vec(),
            };
            invoke(
                &ix,
                &[ctx.accounts.source_token.to_account_info(), dest_info.clone(), ctx.accounts.payer.to_account_info()],
            )?;

            spent.push(staged);
        }
        // 3) every staged attestation is spent: close them and return the rent to the payer.
        for staged in spent {
            staged.close(ctx.accounts.payer.to_account_info())?;
        }
        Ok(())
    }
}

/// `[tag, amount LE]` — the spl-token Transfer instruction data.
pub fn transfer_data(amount: u64) -> [u8; 9] {
    let mut d = [0u8; 9];
    d[0] = TOKEN_IX_TRANSFER;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d
}

/// Parse a classic SPL token account for `mint` and return its owner. Refuses anything that is not an
/// initialized spl-token account for exactly this mint (wrong program, token-2022, frozen, closed).
pub fn token_account_owner(info: &AccountInfo, mint: &Pubkey) -> Result<Pubkey> {
    require_keys_eq!(*info.owner, SPL_TOKEN_ID, GateError::NotTokenAccount);
    let data = info.try_borrow_data()?;
    parse_token_account_owner(&data, mint)
}

/// The pure part of `token_account_owner` (unit-tested on the host).
pub fn parse_token_account_owner(data: &[u8], mint: &Pubkey) -> Result<Pubkey> {
    require!(data.len() == TOKEN_ACCOUNT_LEN, GateError::NotTokenAccount);
    require!(data[108] == TOKEN_STATE_INITIALIZED, GateError::NotTokenAccount);
    let acc_mint = Pubkey::new_from_array(data[0..32].try_into().unwrap());
    require_keys_eq!(acc_mint, *mint, GateError::WrongMint);
    Ok(Pubkey::new_from_array(data[32..64].try_into().unwrap()))
}

/// One payout's variable data; the proof and public inputs come from its staged account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PayoutArgs {
    pub nonce: [u8; 32],
    pub amount: u64,
}

/// A staged attestation: who staged it (only they can spend or cancel it) and the two proof blobs.
#[account]
pub struct Staged {
    pub payer: Pubkey,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
    pub bump: u8,
}

impl Staged {
    pub const fn space(proof_len: usize, public_inputs_len: usize) -> usize {
        8 + 32 + 4 + proof_len + 4 + public_inputs_len + 1
    }
}

#[derive(Accounts)]
#[instruction(proof: Vec<u8>, public_inputs: Vec<u8>, nullifier: [u8; 32])]
pub struct StageAttestation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Staged::space(proof.len(), public_inputs.len()),
        seeds = [STAGED_SEED, payer.key().as_ref(), nullifier.as_ref()],
        bump
    )]
    pub staged: Account<'info, Staged>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelStage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, close = payer, has_one = payer @ GateError::StagedNotPayers)]
    pub staged: Account<'info, Staged>,
}

#[derive(Accounts)]
pub struct BatchPayout<'info> {
    /// The authority every payout debits — also pays for the Nullifier PDAs and gets the staged rent back.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a classic spl-token account for `mint` owned by `payer`; parsed and checked in the handler.
    #[account(mut)]
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: the mint. Only its key is used: it is bound into every action hash and compared to the
    /// mint field of each token account.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: blindseal-verify's Config PDA, validated by the verifier.
    pub config: UncheckedAccount<'info>,
    /// CHECK: blindseal-verify's PolicyRoot PDA (allowlist mode), validated by the verifier.
    pub policy_root: Option<UncheckedAccount<'info>>,
    /// Typed: a call that passes any other program here fails before anything moves.
    pub verify_program: Program<'info, BlindsealVerify>,
    /// CHECK: the SPL Token program (address-constrained).
    #[account(address = SPL_TOKEN_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (address-constrained), forwarded to the verifier, which reads it
    /// to check that the calling program is the attestation's target program.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    // remaining_accounts, per payout: [staged (mut), recipient_token (mut), nullifier (mut)]
}

/// Gate errors are numbered from 7000 so they never collide with blindseal-verify's (6000+), which
/// surface through the same transaction.
#[error_code(offset = 7000)]
pub enum GateError {
    #[msg("attestation's policy root is not one this gated program expects")]
    UnexpectedPolicyRoot,
    #[msg("public inputs must be 168 bytes")]
    BadPublicInputs,
    #[msg("a batch needs at least one payout")]
    EmptyBatch,
    #[msg("remaining accounts must be exactly [staged, recipient_token, nullifier] per payout")]
    WrongAccountCount,
    #[msg("not an initialized classic spl-token account")]
    NotTokenAccount,
    #[msg("token account is for a different mint")]
    WrongMint,
    #[msg("source token account is not owned by the payer")]
    SourceNotPayers,
    #[msg("staged attestation was not staged by this payer")]
    StagedNotPayers,
    #[msg("nullifier seed does not match the committed nullifier in public_inputs")]
    NullifierSeedMismatch,
    #[msg("staged proof exceeds the size bound")]
    ProofTooLong,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_account(mint: &Pubkey, owner: &Pubkey, state: u8) -> Vec<u8> {
        let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[108] = state;
        d
    }

    #[test]
    fn parses_the_owner_of_an_initialized_account_for_the_mint() {
        let mint = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        assert_eq!(parse_token_account_owner(&token_account(&mint, &owner, 1), &mint).unwrap(), owner);
    }

    #[test]
    fn refuses_other_mints_uninitialized_frozen_and_short_accounts() {
        let mint = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        assert!(parse_token_account_owner(&token_account(&Pubkey::new_unique(), &owner, 1), &mint).is_err());
        assert!(parse_token_account_owner(&token_account(&mint, &owner, 0), &mint).is_err());
        assert!(parse_token_account_owner(&token_account(&mint, &owner, 2), &mint).is_err());
        assert!(parse_token_account_owner(&token_account(&mint, &owner, 1)[..100], &mint).is_err());
    }

    #[test]
    fn transfer_data_is_tag_3_then_amount_le() {
        assert_eq!(transfer_data(1_000_000), [3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn staged_space_covers_the_committed_blob_and_a_groth16_proof() {
        assert_eq!(Staged::space(260, 168), 8 + 32 + 4 + 260 + 4 + 168 + 1);
    }
}
