# Per-owner policy roots (design, target 0.9 — not built)

Status: proposal. Release 0.8.0 adds a stateless action policy to the guest and folds it into the policy root
(`policyRoot = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash)`). The root an attestation carries
therefore says which rules screened the call **and** which constraints the action satisfied. This note is about
who decides which roots an action may carry. Nothing here changes a program in 0.8.0.

## Where the decision sits today

Two lists gate a root on chain:

1. **The verifier's registry** (`blindseal-verify`, `register_policy_root`, `allowlist_policies`). Global: one
   authority registers roots for everyone. It answers "is this a root the deployment knows", not "is this the
   root this account wants".
2. **The gated program's constant** (`EXPECTED_POLICY_ROOTS` in transfer-gate and payout-gate). Per program,
   but fixed at build time: changing it means an upgrade, and every owner using that program shares it.

Neither lets the owner of an account — a treasury, a pooled-funds account, an agent's wallet — say "transfers out of **my**
account need an attestation under **my** root", for example a recipient allowlist and a cap only they set.

## Proposal

A per-owner registry in the gated program (or a small shared program the gates read):

```text
OwnerPolicy PDA = PDA(["owner-policy", owner])        -- owner = the source authority the action debits
  owner:        Pubkey
  roots:        [ [u8;32]; ≤ 8 ]                      -- accepted policy roots for actions debiting `owner`
  mode:         u8                                    -- 0 = owner roots only, 1 = owner roots OR the program's defaults
  updated_slot: u64
  bump:         u8
```

- `set_owner_policy(roots, mode)`: signed by `owner` (the same key the action debits), so nobody else can widen
  or narrow the constraints on that account. Closing the account returns to the program's defaults.
- The gate's check becomes: read `public_inputs[32..64]`; if an `OwnerPolicy` exists for the action's
  `sourceAuthority`, the root must be in `roots` (or, in mode 1, in `roots ∪ EXPECTED_POLICY_ROOTS`); otherwise
  the program's `EXPECTED_POLICY_ROOTS` apply. The verifier's registry check is unchanged.
- The PDA is passed as one optional trailing account (the 0.8.0 `allow-missing-optionals` pattern), so clients
  that do not know about it keep working against owners who have none.

## Why per owner, not per program

The action policy only protects an owner if the owner chooses it. A program-wide default protects everyone a
little (for example "native SOL or USDC only"); a per-owner root lets one account owner require "only these three
recipients, at most 50 USDC per action" without forking the gate. Because the policy root already commits to
the action constraints and the guest enforces them, the on-chain side only needs to compare 32 bytes.

## Interactions and limits

- **Rotation.** An owner who changes their policy changes their root; attestations made under the old root stop
  being consumable once `roots` no longer lists it. Unexpired attestations should be consumed or allowed to
  expire first; the UI must say so.
- **Sessions** (`docs/design/session-proofs.md`): a session proof would commit the same policy root, so the
  owner check applies to every call in the session unchanged.
- **Stateless only.** The policy is checked per action. Budgets over time (a daily cap) need state the guest
  does not have; they belong to the session design or to the gated program itself.
- **No change to the proof.** The guest, its vkey and the public inputs stay as in 0.8.0; this is a gate-side
  and SDK change (the SDK computes the owner's root from their policy file with `policyRootFor`).

## Open questions

- Shared registry program versus a PDA inside each gate: a shared one lets several gates honour one owner's
  choice; a per-gate one keeps each gate self-contained.
- Whether `mode 1` (owner roots plus defaults) should exist at all, or owners must list every root they accept.
- Rent and cleanup for owners who never consume again.
