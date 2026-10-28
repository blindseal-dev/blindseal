//! Blindseal on-chain verifier.
//!
//! `verify_and_consume(proof, public_inputs, action)` checks, in this exact order (each failure
//! is a distinct error so a consumer can tell them apart):
//!   1. called by CPI from exactly one level: `get_stack_height() == 2` — a top-level call fails
//!      `DirectCallNotAllowed`, a deeper nesting fails `NestedCallNotAllowed`
//!   2. the caller is the target program: the top-level instruction's program id (instructions
//!      sysvar; at stack height 2 that is the program issuing this CPI) == `action.target_program`,
//!      else `CallerNotTargetProgram`
//!   3. not paused
//!   4. detectorVersion ∈ allowed_vkeys
//!   5. if allowlist_policies: PolicyRoot[policyRoot] exists
//!   6. expirySlot ≥ Clock::slot
//!   7. recompute actionHash from the action fields the CALLER supplies (+ payloadHash,
//!      policyRoot, detectorVersion, expirySlot from the public inputs + nonce) == public actionHash
//!   8. nullifier == sha256(domain || actionHash) and the Nullifier PDA does not exist
//!   9. Groth16 verify via sp1-solana (alt_bn128 syscalls)
//!  10. create the Nullifier PDA (payer = caller), record the calling program as
//!      `consumer_program`, emit `Consumed`
//!
//! Steps 1–2 close a griefing path: before them, anyone who copied a submitted proof could call
//! `verify_and_consume` directly with the same action fields and burn the nullifier before the
//! real gated transaction landed. Now only the program the attestation was screened for can
//! consume it, and `consumer_program` is the true caller.
//!
//! The five wrong-field cases (recipient / amount / mint / target program / source authority)
//! all surface as `ActionHashMismatch` by construction: the proof binds a single hash over all of
//! them, so the program cannot tell which field diverged — only that the caller's action is not
//! the screened one. The hashing layout is byte-for-byte `blindseal_detector_core::action_hash`
//! / `nullifier` (host parity test in tests/).
//!
//! CPI-only. The gated program must pass the action fields IT is about to execute (see
//! transfer-gate), never fields supplied by the agent, and must forward the instructions sysvar.
//!
//! Which payload a proof may carry for an action is the guest's job (0.7.0): before hashing, the
//! guest parses the screened tool call and asserts it describes exactly the bound action, so a
//! proof whose actionHash matches the caller's action here was screened for that action.
//!
//! Admin (authority only): `set_config`, `register_policy_root`, and `set_authority(new)` — the
//! handover needs BOTH the current and the new authority to sign, so a mistyped key cannot take
//! the config; it emits `AuthorityChanged`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    program::invoke_signed,
    system_instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

declare_id!("6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Blindseal verifier",
    project_url: "https://blindseal.tech",
    contacts: "email:blindseal@proton.me",
    policy: "https://blindseal.tech/.well-known/security.txt",
    preferred_languages: "en",
    source_code: "https://github.com/blindseal-dev/blindseal"
}

/// Domain separators — identical to detector-core (the canonical hashing spec).
pub const ACTION_DOMAIN: &[u8] = b"blindseal.action.v1";
pub const NULLIFIER_DOMAIN: &[u8] = b"blindseal.nullifier.v1";
/// The committed public-values blob: payloadHash‖policyRoot‖detectorVersion‖actionHash‖nullifier
/// (5×32) ‖ expirySlot (u64 LE) = 168 bytes.
pub const PUBLIC_INPUTS_LEN: usize = 168;
pub const MAX_VKEYS: usize = 8;

pub const CONFIG_SEED: &[u8] = b"config";
pub const POLICY_SEED: &[u8] = b"policy";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

#[program]
pub mod blindseal_verify {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, allowed_vkeys: Vec<[u8; 32]>, allowlist_policies: bool) -> Result<()> {
        require!(allowed_vkeys.len() <= MAX_VKEYS, VerifyError::TooManyVkeys);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.allowed_vkeys = allowed_vkeys;
        c.allowlist_policies = allowlist_policies;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Authority only. Each field is optional so a single call can flip just `paused`.
    pub fn set_config(
        ctx: Context<AuthorityOnly>,
        allowed_vkeys: Option<Vec<[u8; 32]>>,
        allowlist_policies: Option<bool>,
        paused: Option<bool>,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(v) = allowed_vkeys {
            require!(v.len() <= MAX_VKEYS, VerifyError::TooManyVkeys);
            c.allowed_vkeys = v;
        }
        if let Some(a) = allowlist_policies {
            c.allowlist_policies = a;
        }
        if let Some(p) = paused {
            c.paused = p;
        }
        Ok(())
    }

    /// Authority only, and the new authority must co-sign (a typo cannot brick the config).
    /// `new_authority` must equal the co-signing account.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.new_authority.key(), new_authority, VerifyError::NewAuthorityMismatch);
        let c = &mut ctx.accounts.config;
        let old_authority = c.authority;
        c.authority = new_authority;
        emit!(AuthorityChanged { old_authority, new_authority });
        Ok(())
    }

    /// Authority only. Registers a policy root for allowlist mode.
    pub fn register_policy_root(ctx: Context<RegisterPolicyRoot>, root: [u8; 32]) -> Result<()> {
        let p = &mut ctx.accounts.policy_root;
        p.root = root;
        p.registered_at = Clock::get()?.slot;
        p.bump = ctx.bumps.policy_root;
        Ok(())
    }

    pub fn verify_and_consume(
        ctx: Context<VerifyAndConsume>,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
        action: ActionArgs,
    ) -> Result<()> {
        // 1. CPI from exactly one level. The gated program is the top-level instruction and this
        //    is its direct CPI; a top-level call (anyone replaying a copied proof) or a deeper
        //    nesting is refused before anything else is read.
        let height = get_stack_height();
        require!(height > TRANSACTION_LEVEL_STACK_HEIGHT, VerifyError::DirectCallNotAllowed);
        require!(height == TRANSACTION_LEVEL_STACK_HEIGHT + 1, VerifyError::NestedCallNotAllowed);

        // 2. the caller is the program the attestation was screened for. At stack height 2 the
        //    program issuing this CPI is the current top-level instruction's program.
        let ix_sysvar = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&ix_sysvar)?;
        let caller = load_instruction_at_checked(current as usize, &ix_sysvar)?.program_id;
        require_keys_eq!(caller, action.target_program, VerifyError::CallerNotTargetProgram);

        let config = &ctx.accounts.config;
        require!(public_inputs.len() == PUBLIC_INPUTS_LEN, VerifyError::BadPublicInputs);
        let payload_hash: [u8; 32] = public_inputs[0..32].try_into().unwrap();
        let policy_root: [u8; 32] = public_inputs[32..64].try_into().unwrap();
        let detector_version: [u8; 32] = public_inputs[64..96].try_into().unwrap();
        let action_hash: [u8; 32] = public_inputs[96..128].try_into().unwrap();
        let nullifier: [u8; 32] = public_inputs[128..160].try_into().unwrap();
        let expiry_slot = u64::from_le_bytes(public_inputs[160..168].try_into().unwrap());

        // 3. paused
        require!(!config.paused, VerifyError::Paused);

        // 4. vkey allowlist
        require!(config.allowed_vkeys.iter().any(|k| *k == detector_version), VerifyError::DisallowedVkey);

        // 5. policy allowlist
        if config.allowlist_policies {
            let acc = ctx.accounts.policy_root.as_ref().ok_or(VerifyError::UnregisteredPolicyRoot)?;
            let (expected, _) = Pubkey::find_program_address(&[POLICY_SEED, &policy_root], &crate::ID);
            require_keys_eq!(acc.key(), expected, VerifyError::UnregisteredPolicyRoot);
            require!(acc.owner == &crate::ID && !acc.data_is_empty(), VerifyError::UnregisteredPolicyRoot);
            let data = acc.try_borrow_data()?;
            let reg = PolicyRoot::try_deserialize(&mut &data[..]).map_err(|_| VerifyError::UnregisteredPolicyRoot)?;
            require!(reg.root == policy_root, VerifyError::UnregisteredPolicyRoot);
        }

        // 6. expiry
        let now = Clock::get()?.slot;
        require!(expiry_slot >= now, VerifyError::Expired);

        // 7. actionHash recompute from the caller's action + the committed values
        let recomputed = compute_action_hash(&action, &payload_hash, &policy_root, &detector_version, expiry_slot);
        require!(recomputed == action_hash, VerifyError::ActionHashMismatch);

        // 8. nullifier recompute + not yet consumed
        let nf = compute_nullifier(&action_hash);
        require!(nf == nullifier, VerifyError::NullifierMismatch);
        let (nf_key, nf_bump) = Pubkey::find_program_address(&[NULLIFIER_SEED, &nullifier], &crate::ID);
        let nf_acc = &ctx.accounts.nullifier;
        require_keys_eq!(nf_acc.key(), nf_key, VerifyError::NullifierMismatch);
        require!(nf_acc.lamports() == 0 && nf_acc.data_is_empty(), VerifyError::NullifierAlreadyConsumed);

        // 9. Groth16 verify (SP1 v5 VK, alt_bn128 syscalls)
        let vkey_hex = hex32(&detector_version);
        sp1_solana::verify_proof(&proof, &public_inputs, &vkey_hex, &sp1_solana::GROTH16_VK_5_0_0_BYTES)
            .map_err(|_| VerifyError::InvalidProof)?;

        // 10. create the Nullifier PDA (payer = caller) and record the calling program (step 2
        //     proved it is the top-level program and equals action.target_program)
        let consumer = caller;
        let space = 8 + Nullifier::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(space);
        let seeds: &[&[u8]] = &[NULLIFIER_SEED, &nullifier, &[nf_bump]];
        invoke_signed(
            &system_instruction::create_account(&ctx.accounts.payer.key(), &nf_key, rent, space as u64, &crate::ID),
            &[
                ctx.accounts.payer.to_account_info(),
                nf_acc.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        let record = Nullifier { consumed_at_slot: now, consumer_program: consumer, action_hash, bump: nf_bump };
        let mut data = nf_acc.try_borrow_mut_data()?;
        record.try_serialize(&mut &mut data[..])?;

        emit!(Consumed { nullifier, action_hash, policy_root, consumer });
        Ok(())
    }
}

/// actionHash = sha256(domain ‖ chainId(LE) ‖ targetProgram ‖ sourceAuthority ‖ instruction ‖
/// recipient ‖ mint ‖ amount(LE) ‖ payloadHash ‖ policyRoot ‖ detectorVersion ‖ expirySlot(LE) ‖ nonce)
pub fn compute_action_hash(
    a: &ActionArgs,
    payload_hash: &[u8; 32],
    policy_root: &[u8; 32],
    detector_version: &[u8; 32],
    expiry_slot: u64,
) -> [u8; 32] {
    hashv(&[
        ACTION_DOMAIN,
        &a.chain_id.to_le_bytes(),
        a.target_program.as_ref(),
        a.source_authority.as_ref(),
        &a.instruction,
        a.recipient.as_ref(),
        a.mint.as_ref(),
        &a.amount.to_le_bytes(),
        payload_hash,
        policy_root,
        detector_version,
        &expiry_slot.to_le_bytes(),
        &a.nonce,
    ])
    .to_bytes()
}

/// nullifier = sha256(domain ‖ actionHash)
pub fn compute_nullifier(action_hash: &[u8; 32]) -> [u8; 32] {
    hashv(&[NULLIFIER_DOMAIN, action_hash]).to_bytes()
}

fn hex32(b: &[u8; 32]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 0xf) as usize] as char);
    }
    s
}

/// The on-chain action the gated program is about to execute, plus the attestation's nonce.
/// 32-byte fields are zero when n/a; `mint` is zero for the native asset.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ActionArgs {
    pub chain_id: u16, // 1 = solana mainnet (2 reserved)
    pub target_program: Pubkey,
    pub source_authority: Pubkey,
    pub instruction: [u8; 8],
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub nonce: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    #[max_len(MAX_VKEYS)]
    pub allowed_vkeys: Vec<[u8; 32]>,
    pub allowlist_policies: bool,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PolicyRoot {
    pub root: [u8; 32],
    pub registered_at: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Nullifier {
    pub consumed_at_slot: u64,
    pub consumer_program: Pubkey,
    pub action_hash: [u8; 32],
    pub bump: u8,
}

#[event]
pub struct Consumed {
    pub nullifier: [u8; 32],
    pub action_hash: [u8; 32],
    pub policy_root: [u8; 32],
    pub consumer: Pubkey,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ VerifyError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[event]
pub struct AuthorityChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ VerifyError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(root: [u8; 32])]
pub struct RegisterPolicyRoot<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ VerifyError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + PolicyRoot::INIT_SPACE, seeds = [POLICY_SEED, &root], bump)]
    pub policy_root: Account<'info, PolicyRoot>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyAndConsume<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: validated in the handler against PDA(b"policy", policyRoot) when allowlist mode is on.
    pub policy_root: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA(b"nullifier", nullifier), created in the handler; must not exist yet.
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (address-constrained); read to identify the calling program.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[error_code]
pub enum VerifyError {
    #[msg("verifier is paused")]
    Paused,
    #[msg("detectorVersion is not an allowed vkey")]
    DisallowedVkey,
    #[msg("policy root is not registered (allowlist mode)")]
    UnregisteredPolicyRoot,
    #[msg("attestation expired")]
    Expired,
    #[msg("action does not match the screened action (actionHash mismatch)")]
    ActionHashMismatch,
    #[msg("nullifier does not match actionHash")]
    NullifierMismatch,
    #[msg("nullifier already consumed (replay)")]
    NullifierAlreadyConsumed,
    #[msg("Groth16 proof did not verify")]
    InvalidProof,
    #[msg("public inputs must be 168 bytes")]
    BadPublicInputs,
    #[msg("too many vkeys")]
    TooManyVkeys,
    #[msg("unauthorized")]
    Unauthorized,
    // Appended (2026-10-27) so the codes above keep their numbers.
    #[msg("verify_and_consume must be called by CPI from the target program, not as a top-level instruction")]
    DirectCallNotAllowed,
    #[msg("verify_and_consume must be called by exactly one CPI level (the top-level target program)")]
    NestedCallNotAllowed,
    #[msg("calling program is not the action's target program")]
    CallerNotTargetProgram,
    // Appended (0.7.0).
    #[msg("new_authority argument does not match the co-signing new authority account")]
    NewAuthorityMismatch,
}
