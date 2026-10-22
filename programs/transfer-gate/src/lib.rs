//! Blindseal example gated program (M0 stub). See BLINDSEAL.md §3.7.
//!
//! M2: an SPL transfer that CPIs blindseal-verify in the same transaction, forwarding
//! the recipient/amount/mint and source authority it is about to execute. Direct entry
//! without the CPI must fail; a failed transfer reverts the tx so the nullifier is unconsumed.
