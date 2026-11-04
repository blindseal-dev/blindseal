//! Stateless action policy (release 0.8.0).
//!
//! An optional set of constraints on the action an attestation binds: allowed recipients, a maximum
//! amount per action, allowed target programs, allowed instructions and allowed mints. The guest
//! asserts the bound action satisfies the policy; an empty list (or an absent maximum) means no
//! constraint on that field. The policy is committed through the policy root:
//!
//! ```text
//! actionPolicyHash = sha256("blindseal.action-policy.v1"
//!                           ‖ u32le |R| ‖ R[0] ‖ … ‖ R[|R|-1]          recipients, 32 bytes each
//!                           ‖ u8 hasMax ‖ u64le max                    max = 0 when hasMax = 0
//!                           ‖ u32le |P| ‖ P…                           target programs, 32 bytes each
//!                           ‖ u32le |I| ‖ I…                           instructions, 8 bytes each
//!                           ‖ u32le |M| ‖ M…)                          mints, 32 bytes each
//! policyRoot       = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash)
//! ```
//!
//! Canonical form: each list sorted ascending by its bytes with duplicates removed, before hashing and
//! before checking — the guest canonicalizes whatever it is given, so the order a policy file lists
//! entries in never changes the root. "No maximum" is the explicit flag `hasMax = 0`, never a zero
//! amount: `hasMax = 1, max = 0` allows only zero-amount actions. The native asset (SOL) is the
//! all-zero mint, which can be listed like any other mint. `rulesRoot` is the Merkle root over the
//! L1 rule DFAs (`policy_root_from_serialized`, the 0.7 policy root). The TypeScript mirror is
//! `packages/sdk/src/policy.ts`; both run `evals/vectors/action-policy.json`.

use crate::ActionFields;
use sha2::{Digest, Sha256};

pub const ACTION_POLICY_DOMAIN: &str = "blindseal.action-policy.v1";
pub const POLICY_V2_DOMAIN: &str = "blindseal.policy.v2";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionPolicy {
    pub recipients: Vec<[u8; 32]>,
    pub max_amount: Option<u64>,
    pub target_programs: Vec<[u8; 32]>,
    pub instructions: Vec<[u8; 8]>,
    pub mints: Vec<[u8; 32]>,
}

/// Why an action does not satisfy the policy. `code()` is the stable name the TS mirror uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    RecipientNotAllowed,
    AmountOverMax,
    TargetProgramNotAllowed,
    InstructionNotAllowed,
    MintNotAllowed,
}

impl PolicyError {
    pub fn code(&self) -> &'static str {
        match self {
            PolicyError::RecipientNotAllowed => "recipient-not-allowed",
            PolicyError::AmountOverMax => "amount-over-max",
            PolicyError::TargetProgramNotAllowed => "target-program-not-allowed",
            PolicyError::InstructionNotAllowed => "instruction-not-allowed",
            PolicyError::MintNotAllowed => "mint-not-allowed",
        }
    }
}

impl core::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.code())
    }
}

fn canon<T: Ord + Clone>(v: &[T]) -> Vec<T> {
    let mut c = v.to_vec();
    c.sort();
    c.dedup();
    c
}

impl ActionPolicy {
    /// The empty policy: no constraint on any field.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Sorted, deduplicated lists (the form that is hashed and checked).
    pub fn canonical(&self) -> Self {
        ActionPolicy {
            recipients: canon(&self.recipients),
            max_amount: self.max_amount,
            target_programs: canon(&self.target_programs),
            instructions: canon(&self.instructions),
            mints: canon(&self.mints),
        }
    }

    pub fn hash(&self) -> [u8; 32] {
        let c = self.canonical();
        let mut h = Sha256::new();
        h.update(ACTION_POLICY_DOMAIN.as_bytes());
        h.update((c.recipients.len() as u32).to_le_bytes());
        for r in &c.recipients {
            h.update(r);
        }
        h.update([c.max_amount.is_some() as u8]);
        h.update(c.max_amount.unwrap_or(0).to_le_bytes());
        h.update((c.target_programs.len() as u32).to_le_bytes());
        for p in &c.target_programs {
            h.update(p);
        }
        h.update((c.instructions.len() as u32).to_le_bytes());
        for i in &c.instructions {
            h.update(i);
        }
        h.update((c.mints.len() as u32).to_le_bytes());
        for m in &c.mints {
            h.update(m);
        }
        h.finalize().into()
    }

    /// The bound action must satisfy every non-empty constraint. Fields are checked in a fixed order
    /// (recipient, amount, target program, instruction, mint); the first failing one is reported.
    pub fn check(&self, a: &ActionFields) -> Result<(), PolicyError> {
        if !self.recipients.is_empty() && !self.recipients.contains(&a.recipient) {
            return Err(PolicyError::RecipientNotAllowed);
        }
        if let Some(max) = self.max_amount {
            if a.amount > max {
                return Err(PolicyError::AmountOverMax);
            }
        }
        if !self.target_programs.is_empty() && !self.target_programs.contains(&a.target_program) {
            return Err(PolicyError::TargetProgramNotAllowed);
        }
        if !self.instructions.is_empty() && !self.instructions.contains(&a.instruction) {
            return Err(PolicyError::InstructionNotAllowed);
        }
        if !self.mints.is_empty() && !self.mints.contains(&a.mint) {
            return Err(PolicyError::MintNotAllowed);
        }
        Ok(())
    }
}

/// policyRoot = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash).
pub fn policy_root_v2(rules_root: &[u8; 32], action_policy_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(POLICY_V2_DOMAIN.as_bytes());
    h.update(rules_root);
    h.update(action_policy_hash);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action() -> ActionFields {
        ActionFields {
            chain_id: 1,
            target_program: [1; 32],
            source_authority: [2; 32],
            instruction: [3; 8],
            recipient: [4; 32],
            mint: [0; 32],
            amount: 1_000_000,
        }
    }

    #[test]
    fn empty_policy_allows_anything() {
        assert_eq!(ActionPolicy::empty().check(&action()), Ok(()));
    }

    #[test]
    fn each_constraint_refuses() {
        let a = action();
        let p = ActionPolicy { recipients: vec![[9; 32]], ..Default::default() };
        assert_eq!(p.check(&a), Err(PolicyError::RecipientNotAllowed));
        let p = ActionPolicy { max_amount: Some(999_999), ..Default::default() };
        assert_eq!(p.check(&a), Err(PolicyError::AmountOverMax));
        let p = ActionPolicy { target_programs: vec![[9; 32]], ..Default::default() };
        assert_eq!(p.check(&a), Err(PolicyError::TargetProgramNotAllowed));
        let p = ActionPolicy { instructions: vec![[9; 8]], ..Default::default() };
        assert_eq!(p.check(&a), Err(PolicyError::InstructionNotAllowed));
        let p = ActionPolicy { mints: vec![[9; 32]], ..Default::default() };
        assert_eq!(p.check(&a), Err(PolicyError::MintNotAllowed));
    }

    #[test]
    fn max_zero_is_not_unlimited_and_native_mint_is_listable() {
        let a = action();
        assert_eq!(ActionPolicy { max_amount: Some(0), ..Default::default() }.check(&a), Err(PolicyError::AmountOverMax));
        assert_eq!(ActionPolicy { max_amount: Some(1_000_000), ..Default::default() }.check(&a), Ok(()));
        assert_eq!(ActionPolicy { mints: vec![[0; 32]], ..Default::default() }.check(&a), Ok(()));
        assert_ne!(
            ActionPolicy { max_amount: Some(0), ..Default::default() }.hash(),
            ActionPolicy::empty().hash(),
            "hasMax distinguishes a zero cap from no cap"
        );
    }

    #[test]
    fn hash_is_order_and_duplicate_independent() {
        let a = ActionPolicy { recipients: vec![[2; 32], [1; 32], [2; 32]], ..Default::default() };
        let b = ActionPolicy { recipients: vec![[1; 32], [2; 32]], ..Default::default() };
        assert_eq!(a.hash(), b.hash());
    }
}
