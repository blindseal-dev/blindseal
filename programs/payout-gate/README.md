# payout-gate — a batch of SPL payouts, one Blindseal attestation each

Example gated program (Anchor 0.31.1), alongside `transfer-gate`. One `batch_payout` instruction executes
N SPL token transfers from the signing payer; every payout carries its own attestation and is verified and
consumed by its own `verify_and_consume` CPI into `blindseal-verify`, with the action hash recomputed from
the payout that is executed. If any payout fails — bad proof, wrong field, consumed nullifier, failed
transfer — the whole batch reverts: nothing moves and no nullifier is consumed.

Program id (localnet, fixed): `EPgeMVvpCDaCGoav5NDFBySPTxASBQfVEvaUY6KPKL4k`. Not deployed to mainnet.

## What an attestation must bind

Per payout the gate forwards, from its own accounts and arguments:

| action field | value |
|---|---|
| `targetProgram` | this program's id |
| `instruction` | `batch_payout`'s discriminator, `sha256("global:batch_payout")[..8]` = `0x19eef5f04d0d4e44` |
| `sourceAuthority` | the signing `payer` (owner of `source_token`) |
| `recipient` | the OWNER of the destination token account — the party paid, not the token account address |
| `mint` | the batch's `mint` |
| `amount` | the payout's `amount` |
| `nonce` | the payout's `nonce` argument |

A tool call screened by the proxy maps to this with `program` = this id and `instruction` = `batch_payout`
(see `tests/fixtures/payload-payout-1.json`); the guest binds payload to action before hashing (0.7.0).

## Why attestations are staged

A Groth16 proof is 260 bytes and the committed public inputs 168. Two of them plus the account keys do not
fit in one 1232-byte transaction, so a batch with inline proofs could never hold more than one payout. The
payer therefore stages each attestation first:

1. `stage_attestation(proof, public_inputs, nullifier)` — writes one attestation into
   `PDA(["staged", payer, nullifier])` (the payer pays the rent). Any number of transactions, any time
   before the batch. Nothing is verified here; the verifier does every check at payout time.
2. `batch_payout(payouts: [{ nonce, amount }])` — fixed accounts `payer` (signer), `source_token`,
   `mint`, `config`, `policy_root` (optional), `verify_program`, `token_program`, `system_program`,
   `instructions` sysvar; then, per payout in order, three remaining accounts: `[staged, recipient_token,
   nullifier]`. Each staged account is closed back to the payer in the same batch.
3. `cancel_stage` — returns the rent of an attestation that will not be used.

Staging binds nothing: the verifier recomputes the action from the gate's accounts, so a staged proof is as
inert as a proof on disk; only the staging payer can spend or cancel a staged account.

Checks, per payout, before the CPI: the staged account is this program's and this payer's; the committed
policy root is in `EXPECTED_POLICY_ROOTS` (integrators: set yours); the destination is an initialized
classic spl-token account for `mint` (token-2022 is refused; the layout read is `mint[0..32]`,
`owner[32..64]`, `state[108]`). Then `verify_and_consume`, then spl-token `Transfer`, then close.

Compute: one `verify_and_consume` is about 270k CU, so the 1.4M CU transaction limit bounds a batch at
roughly four payouts. Errors are numbered from 7000 (no collision with the verifier's 6000+).

## Tests

`scripts/test-m2.sh` runs `tests/payout-gate.spec.ts` after the M2 suite on the same local validator. The
suite creates a 6-decimal mint and ATAs for seeded wallets (`sha256("blindseal-localnet:payout-payer")`,
`…:payout-recipient-1`, `…:payout-recipient-2`, `…:payout-mint`), stages attestations and runs batches.

Runs today, with the committed localnet attestations (which are screened for transfer-gate):

- staging: PDA contents; a nullifier seed that is not the committed one, and a short blob, are refused;
- a batch of two whose attestations were screened for another program is refused by the verifier with
  `ActionHashMismatch`, nothing moves, nothing is consumed, staged accounts are kept;
- every gate-side check: `WrongMint`, `NotTokenAccount`, `SourceNotPayers`, `WrongAccountCount`,
  `EmptyBatch`, `StagedNotPayers`, `UnexpectedPolicyRoot`;
- `cancel_stage`: only the staging payer, rent returned;
- a payout whose amount differs from its attestation: `ActionHashMismatch`.

PENDING until `tests/fixtures/attestation-payout-1.json` and `-2.json` exist (each a real ~2 h CPU prove:
`scripts/prove-localnet-fixture.sh payout`, which binds the seeded wallets above, amounts 250000 and
750000, this program and `batch_payout`):

- the happy path: two valid payouts in one transaction, both nullifiers consumed with
  `consumer_program` = payout-gate, staged accounts closed, tokens moved;
- one payout's amount differs inside an otherwise valid batch: `ActionHashMismatch` and the valid
  payout's nullifier is rolled back too;
- replay of a consumed attestation: `NullifierAlreadyConsumed`.

The suite reports these as pending, never as passed, and runs them the moment the fixtures are present.
