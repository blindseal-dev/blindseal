//! Blindseal example gated program (BLINDSEAL.md §3.7): a native-SOL transfer that executes
//! only if a Blindseal attestation for THIS exact transfer verifies and is consumed in the same
//! transaction.
//!
//! The action fields forwarded to the CPI come from the accounts and args of the transfer the
//! program is about to execute — the signer it debits (`source`), the `recipient`, the `amount`,
//! its own program id and instruction discriminator — never from anything the agent supplies.
//! Binding `source_authority` stops an attestation screened for one authority from moving a
//! different authority's funds. If the transfer fails the whole transaction reverts, so the
//! Nullifier PDA is not created and the attestation can be retried (atomicity).
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use blindseal_verify::program::BlindsealVerify;
use blindseal_verify::{cpi::accounts::VerifyAndConsume, ActionArgs};

declare_id!("ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Blindseal transfer-gate (example consumer)",
    project_url: "https://github.com/blindseal-dev/blindseal",
    contacts: "email:blindseal@proton.me",
    policy: "https://github.com/blindseal-dev/blindseal/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/blindseal-dev/blindseal"
}

pub const CHAIN_ID_SOLANA_MAINNET: u16 = 1;

#[program]
pub mod transfer_gate {
    use super::*;

    pub fn gated_transfer(
        ctx: Context<GatedTransfer>,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
        nonce: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        // The action we are about to execute — built from OUR accounts/args, not the agent's.
        let disc: [u8; 8] = <crate::instruction::GatedTransfer as anchor_lang::Discriminator>::DISCRIMINATOR
            .try_into()
            .expect("8-byte discriminator");
        let action = ActionArgs {
            chain_id: CHAIN_ID_SOLANA_MAINNET,
            target_program: crate::ID,
            source_authority: ctx.accounts.source.key(),
            instruction: disc,
            recipient: ctx.accounts.recipient.key(),
            mint: Pubkey::default(), // native SOL
            amount,
            nonce,
        };

        // 1) verify + consume the nullifier (reverts the whole tx on any failure)
        let cpi_accounts = VerifyAndConsume {
            config: ctx.accounts.config.to_account_info(),
            policy_root: ctx.accounts.policy_root.as_ref().map(|a| a.to_account_info()),
            nullifier: ctx.accounts.nullifier.to_account_info(),
            payer: ctx.accounts.source.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        blindseal_verify::cpi::verify_and_consume(
            CpiContext::new(ctx.accounts.verify_program.to_account_info(), cpi_accounts),
            proof,
            public_inputs,
            action,
        )?;

        // 2) execute the screened transfer. A failure here (e.g. insufficient lamports) unwinds
        //    the nullifier creation above with it.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct GatedTransfer<'info> {
    /// The authority the transfer debits — also pays for the Nullifier PDA.
    #[account(mut)]
    pub source: Signer<'info>,
    /// CHECK: any account may receive lamports; the attestation binds this exact key.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: blindseal-verify's Config PDA, validated by the verifier.
    pub config: UncheckedAccount<'info>,
    /// CHECK: blindseal-verify's PolicyRoot PDA (allowlist mode), validated by the verifier.
    pub policy_root: Option<UncheckedAccount<'info>>,
    /// CHECK: blindseal-verify's Nullifier PDA, created by the verifier.
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,
    /// Typed: a direct call that passes any other program here fails before the transfer.
    pub verify_program: Program<'info, BlindsealVerify>,
    pub system_program: Program<'info, System>,
}
