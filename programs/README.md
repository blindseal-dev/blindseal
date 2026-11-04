# programs/ — Blindseal Solana programs (Anchor 0.31.1)

Built with `scripts/build-programs.sh` (`cargo build-sbf --tools-version v1.57` + `anchor idl build`);
the on-chain suite runs on a local validator with `scripts/test-m2.sh`.

- `blindseal-verify` — Groth16 verify (sp1-solana) + nullifier set + vkey/policy allowlists; CPI-only.
  The exact check order is documented in the header of `blindseal-verify/src/lib.rs`.
- `transfer-gate` — example gated native-SOL transfer that requires an attestation.
- `rogue-caller` — TEST-ONLY native forwarder for the M2 suite (a CPI from a program other than the
  attestation's target must fail); loaded at an id generated per test run, never deployed.

## blindseal-verify: accounts and layouts (0.8.0)

`verify_and_consume(proof, public_inputs, action)` — CPI only, from the action's target program:

| # | account | flags | what |
|---|---|---|---|
| 0 | `config` | read | `PDA(["config"])` |
| 1 | `policy_root` | read, optional | `PDA(["policy", policyRoot])`; pass the program id for None |
| 2 | `nullifier` | writable | `PDA(["nullifier", nullifier])`, must not exist |
| 3 | `payer` | signer, writable | pays the Nullifier PDA rent |
| 4 | `fee_payer` | signer, writable | debited `Config.fee_lamports` on a successful consume (transfer-gate forwards its `source` here) |
| 5 | `treasury` | writable | must be `Config.treasury`; while none is configured (zero key) pass the fee payer |
| 6 | `system_program` | | |
| 7 | `instructions` | | the instructions sysvar, read to identify the calling program |

The fee payer and treasury are in the list whether or not a fee is set (fixed layout). The fee moves after
every check has passed, right before the Nullifier PDA is created, so a refused or invalid proof charges
nothing beyond the transaction fee. `paused` and the treasury check come first.

`set_fee(fee_lamports: u64, treasury: Pubkey)` — authority only. Accounts: `config` (writable), `authority`
(signer, writable: pays the realloc), `system_program`. Data: `sha256("global:set_fee")[..8] ‖ u64 LE ‖ 32
bytes`. A fee above 0 with the zero-key treasury fails `TreasuryUnset`. Emits `FeeChanged`.

Config account (`PDA(["config"])`, owner blindseal-verify):

```
offset  size  field
0       8     discriminator  sha256("account:Config")[..8]
8       32    authority
40      4     allowed_vkeys length n (≤ 8)
44      32·n  allowed_vkeys
44+32n  1     allowlist_policies
45+32n  1     paused
46+32n  1     bump
47+32n  8     fee_lamports   (0.8.0)
55+32n  32    treasury       (0.8.0; the zero key = none)
```

Pre-0.8.0 accounts are 303 bytes (`8 + 32 + 4 + 8·32 + 3`, zero behind the written vkeys); 0.8.0 accounts are
343. The 0.8.0 program reads a 303-byte account unchanged: Borsh takes `fee_lamports` and `treasury` from the
zero padding (0 / zero key), which holds for up to 6 vkeys (the padding must be ≥ 40 bytes; mainnet has 2). The
first `set_fee` call reallocs the account to 343 bytes (new bytes zeroed, rent difference paid by the authority)
— `set_fee(0, treasury)` is the migration call. The SDK's `decodeConfig` reads both sizes.

Errors (6000 + index): … `6014 NewAuthorityMismatch`, `6015 TreasuryMismatch` (treasury account is not
`Config.treasury`), `6016 TreasuryUnset` (a fee above 0 needs a treasury). transfer-gate's errors start at 7000.
