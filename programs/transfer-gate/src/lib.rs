//! Blindseal example gated program: a native-SOL transfer that executes
//! only if a Blindseal attestation for THIS exact transfer verifies and is consumed in the same
//! transaction.
//!
//! The action fields forwarded to the CPI come from the accounts and args of the transfer the
//! program is about to execute — the signer it debits (`source`), the `recipient`, the `amount`,
//! its own program id and instruction discriminator — never from anything the agent supplies.
//! Binding `source_authority` stops an attestation screened for one authority from moving a
//! different authority's funds. If the transfer fails the whole transaction reverts, so the
//! Nullifier PDA is not created and the attestation can be retried (atomicity).
//!
//! Policy (release 0.7.0): before the CPI the gate checks that the attestation's committed policy
//! root is one IT expects (`EXPECTED_POLICY_ROOTS`), else `UnexpectedPolicyRoot`. The verifier's
//! own allowlist (allowlist_policies + register_policy_root) is the operator's global gate; this
//! constant is the integrator's: a proof screened under any other rule set — e.g. the default
//! policy with one rule copied over another, which commits a different root — is refused here even
//! if someone registered its root with the verifier.
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use blindseal_verify::program::BlindsealVerify;
use blindseal_verify::{cpi::accounts::VerifyAndConsume, ActionArgs, PUBLIC_INPUTS_LEN};

declare_id!("9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Blindseal transfer-gate (example consumer)",
    project_url: "https://blindseal.tech",
    contacts: "email:blindseal@proton.me",
    policy: "https://blindseal.tech/.well-known/security.txt",
    preferred_languages: "en",
    source_code: "https://github.com/blindseal-dev/blindseal"
}

pub const CHAIN_ID_SOLANA_MAINNET: u16 = 1;

/// The default Blindseal policy root: the merkle root over detector-core's L1 rules + the zero-width
/// threshold (evals/vectors/policy-root.txt; 23 leaves). Unchanged by the 0.7.0 guest.
pub const DEFAULT_POLICY_ROOT: [u8; 32] = [
    0x36, 0xa9, 0xe9, 0x45, 0x7d, 0xb6, 0xec, 0xfd, 0x75, 0x2a, 0x37, 0x9f, 0xc9, 0x27, 0x9a, 0xd6,
    0xa0, 0xac, 0xfe, 0xa0, 0x79, 0x28, 0xf6, 0x1e, 0x2f, 0x36, 0x38, 0xa6, 0x85, 0xc3, 0x83, 0x97,
];

/// The policy roots THIS gated program accepts. INTEGRATORS: this is yours to set — list the
/// policy root(s) of the rule set(s) you require your agents' tool calls to be screened under
/// (a custom policy has its own root), and rebuild. The verifier's allowlist is checked as well.
pub const EXPECTED_POLICY_ROOTS: &[[u8; 32]] = &[DEFAULT_POLICY_ROOT];

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
        // 0) the attestation must have been screened under a policy this gate expects.
        require!(public_inputs.len() == PUBLIC_INPUTS_LEN, GateError::BadPublicInputs);
        let policy_root: [u8; 32] = public_inputs[32..64].try_into().unwrap();
        require!(EXPECTED_POLICY_ROOTS.contains(&policy_root), GateError::UnexpectedPolicyRoot);

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

        // 1) verify + consume the nullifier (reverts the whole tx on any failure). The verifier only
        //    accepts this CPI when gated_transfer is the top-level instruction (it reads the
        //    instructions sysvar to check that its caller is the attestation's target program).
        let cpi_accounts = VerifyAndConsume {
            config: ctx.accounts.config.to_account_info(),
            policy_root: ctx.accounts.policy_root.as_ref().map(|a| a.to_account_info()),
            nullifier: ctx.accounts.nullifier.to_account_info(),
            payer: ctx.accounts.source.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            instructions: ctx.accounts.instructions.to_account_info(),
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
    /// CHECK: the instructions sysvar (address-constrained), forwarded to the verifier, which
    /// reads it to check that the calling program is the attestation's target program.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Gate errors are numbered from 7000 so they never collide with blindseal-verify's (6000+), which
/// surface through the same transaction.
#[error_code(offset = 7000)]
pub enum GateError {
    #[msg("attestation's policy root is not one this gated program expects")]
    UnexpectedPolicyRoot,
    #[msg("public inputs must be 168 bytes")]
    BadPublicInputs,
}
