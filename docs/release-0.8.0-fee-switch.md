# Release 0.8.0: the verifier fee switch (read before signing)

`Config` gains `fee_lamports: u64` and `treasury: Pubkey` (default 0 / none). When a fee is set, every
successful `verify_and_consume` moves exactly `fee_lamports` from the calling program's fee payer to the
treasury, after every check has passed and in the same transaction as the Nullifier creation. transfer-gate
forwards its `source` as the fee payer. Nothing is sent to mainnet by this branch; the owner signs the steps
below later. Layouts and account lists: `programs/README.md`.

Numbers below come from a read-only read of live mainnet (`getAccountInfo`, `solana program show`,
`solana program dump`), the localnet suites, and the verifiable build of this branch.

## Live state (read-only, 2026-11-04)

| | |
|---|---|
| Config PDA | `9je2jP8yLogrSbm6qxDFjjQXKKwk9A25KMqwXCqDb4M3` — **303 bytes**, 2,189,480 lamports; 1 vkey (`CURRENT_VKEY`), approved policies on, not paused. Decoded with the 0.8.0 SDK: `feeLamports 0`, `treasury` = zero key, `hasFeeFields false`. |
| blindseal-verify | `6z4Heh…`, ProgramData `FEkyNt5J4VjkJpSNniaJjFB5JZwFr3ZoHtUUvg3Mko1x`, **366,672 B** (last deployed slot 463,414,112), executable hash `5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed` (= the 0.7.0 verifiable build) |
| transfer-gate | `9fjiag…`, ProgramData `6cWCSq7eiEet65T3tzLWyFSTmTeRNXHvi62pJtxZtAjZ`, **192,720 B** (slot 463,413,826), executable hash `a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86` (= 0.7.0) |
| Mainnet rent | 5,080 lamports per byte incl. the 128-byte overhead: 303 B → 2,189,480; 343 B → 2,392,680; difference **203,200 lamports**. |

## Verifiable build of this branch

Built with `solanafoundation/solana-verifiable-build:4.3.0` (`cd programs && solana-verify build -b
solanafoundation/solana-verifiable-build:4.3.0 --library-name <lib>`, the image the deployed 0.7.0 bytes came
from; `solana-verify 0.5.2`), from the last commit of this branch that touches `programs/` (step 0 of the
mainnet script prints the HEAD it builds; `git diff <that commit> HEAD -- programs` must be empty). The
localnet suites below ran against these exact binaries (`BLINDSEAL_SO_DIR`).

| program | binary | `solana-verify get-executable-hash` | sha256 of the .so | ProgramData today | growth | `ExtendProgram` |
|---|---|---|---|---|---|---|
| transfer_gate | **188,008 B** | `7e43df38dd14e1ab923e2bfa871269cee05882285770174b2a8e414349f88703` | `22e2bf2199867d41b1d57613443b3c9eac24a469babceef6d7cdc1662c2deec3` | 192,720 B | fits (−4,712) | **no** |
| blindseal_verify | **380,712 B** | `90796b66d413adea876bdfb66360c8c094b6c58772c33cecde6bbca6754fad1f` | `f56abd84443e182dc16a0718b8bfd40a687a0ad443800d284c2de5644f9bcbb9` | 366,672 B | **+14,040 B** | **yes** — the CLI extends by max(growth, 10,240) = 14,040 B in the create-buffer transaction, giving ProgramData 380,712 B |

For comparison, the plain `scripts/build-programs.sh` (`cargo build-sbf` v1.57 on this machine) gives
175,624 B / 361,528 B with different hashes; only the image build reproduces the deployed bytes.

**sBPF version.** The image emits sBPF **v0** ELFs (`e_flags = 0`), like the deployed 0.7.0 binaries; the
local v1.57 toolchain emits v3. Mainnet has **not** activated SIMD-0500
(`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`, "disable deployment of SBPF v0, v1 and v2 programs"; read with
`solana feature status`), so these binaries deploy today exactly as 0.7.0 did. If that feature activates
before the upgrade is signed, the 4.3.0 image can no longer deploy and the verifiable toolchain has to move
(the hashes above change with it) — check `solana feature status -u <rpc> | grep B8JJ` on the day. A fresh
`solana-test-validator` activates every feature, including this one, so the migration rehearsal deactivates it.

Deploy cost at mainnet rent (5,080 lamports per byte incl. the 128-byte overhead; the figures follow
`scripts/mainnet-0.7.0.sh` step 0 and `docs/release-0.7.0-mainnet-plan.md`, 1,012 program bytes per write):

| | transfer_gate | blindseal_verify |
|---|---|---|
| Transactions | 1 create buffer + 186 writes + 1 upgrade = **188** | 1 create buffer **+ extend** + 377 writes + 1 upgrade = **379** |
| Buffer rent, held during the deploy and refunded by Upgrade | 0.955918840 SOL (188,008 + 37 + 128 B) | 1.934855160 SOL (380,712 + 37 + 128 B) |
| ProgramData growth rent (kept) | 0 | **0.071323200 SOL** (14,040 B × 5,080) |
| Fees at 5,000 lamports per signature | 0.000945000 SOL | 0.001900000 SOL |

Upgrade transfer-gate first, then blindseal-verify, as in 0.7.0. `solana program deploy` refuses when the
upgrade authority's balance is short of the largest buffer + growth + fees; `scripts/mainnet-0.7.0.sh --dry-run 0`
prints the same plan from live state and can be pointed at these binaries.

## Why the upgrade is safe before `set_fee`

The 0.8.0 program reads the 303-byte Config unchanged: Borsh stops at `bump` and takes `fee_lamports` and
`treasury` from the zero padding behind the vkey vector (0 / zero key). This holds while at most 6 vkeys are
allowed (padding ≥ 40 bytes); mainnet allows 1. `set_config` on the legacy account re-serializes the new
struct into the 303 bytes (151 bytes used with 2 vkeys). Host test:
`programs/blindseal-verify/tests/config_layout.rs`. Localnet rehearsal of the whole sequence with the
deployed binary: `scripts/test-fee-migration.sh` (section below).

Until `set_fee` sets a treasury, clients pass their fee payer in the treasury slot (the zero key cannot be
passed as a writable account); the SDK does this by itself (`treasuryAccount`, and `submit()` reads the
Config). With a treasury set, any other account in that slot fails `TreasuryMismatch`, fee or no fee.

## Migration steps (in order)

1. **Upgrade transfer-gate, then blindseal-verify** from the verifiable builds (hashes above), as in
   `docs/release-0.7.0-mainnet-plan.md` step 0 (`solana program deploy`, CLI 4.3.1, auto-extends ProgramData
   when the binary grew; see the growth column). The old gate cannot call the new verifier (it does not pass
   the new accounts) and the new gate cannot call the old one, so **both upgrades land before any gated
   transaction is sent**; the SDK 0.8.0 is published after both.
2. **`set_fee(0, <treasury>)`** — reallocs Config 303 → 343 bytes, sets the treasury, charges nothing yet.
   The treasury must be an existing rent-exempt account (a fee smaller than the rent-exempt minimum
   cannot create one); the authority itself is a fine first treasury.
3. **Later, `set_fee(<n>, <treasury>)`** — turns the fee on. `set_fee(0, <treasury>)` turns it off again.
   A fee above 0 with the zero-key treasury is refused (`TreasuryUnset`).

### `set_fee` instruction (sign-list entry)

| | |
|---|---|
| Program | `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` |
| Instructions | ComputeBudget `SetComputeUnitLimit(50,000)`, then `set_fee` |
| Accounts | Config `9je2jP…` (writable); authority `88sR7X…` (signer, **writable**: pays the realloc); System program `1111…` (read-only) |
| Data (48 bytes) | `sha256("global:set_fee")[..8]` = `129a1812edd61350` ‖ `fee_lamports` as u64 little-endian (8 bytes) ‖ `treasury` (32 bytes) |
| Step 2 data | `129a1812edd61350 0000000000000000 <treasury 32 bytes>` |
| Step 3 data | `129a1812edd61350 <n as u64 LE> <treasury 32 bytes>` |
| Signer and fee payer | `88sR7X…` (the Config authority) |
| Fee | 5,000 lamports per step |
| Rent | step 2: **203,200 lamports** moved from the authority into the Config account (303 → 343 bytes at 5,080/byte); step 3 and later: none |
| Config change | step 2: `treasury` zero key → `<treasury>`, size 303 → 343; step 3: `feeLamports` 0 → n |
| Event | `FeeChanged { fee_lamports, treasury }` |
| Builder | `buildSetFeeIx(authority, feeLamports, treasury)` (`packages/sdk/src/ix.ts`) |

Sign-list text, step 2: "blindseal-verify `set_fee(0, <treasury>)`: Config `9je2jP…` grows from 303 to 343
bytes (+203,200 lamports rent from `88sR7X…`), treasury set to `<treasury>`, fee stays 0. Accounts: Config
(w), `88sR7X…` (s, w), System program. Data `129a1812edd61350 00·8 <treasury>`. Nothing is charged to anyone until
step 3."

Sign-list text, step 3: "blindseal-verify `set_fee(<n>, <treasury>)`: every successful consume now moves n
lamports from the gated transaction's signer to `<treasury>`. Same accounts; data `129a1812edd61350 <n LE> <treasury>`.
No rent."

## What the localnet suites show

Programs built by `scripts/build-programs.sh` and, for the final run, the verifiable binaries above
(`BLINDSEAL_SO_DIR`), on a local Agave 4.3.1 validator.

`scripts/test-m2.sh` — **36 passing** (the 0.7.x suite plus the fee block), with the two committed real proofs:

- the fee-0 happy path consumes the legacy fixture: the source pays the transaction fee + Nullifier rent +
  amount and nothing else; the (future) treasury account is untouched;
- `set_fee` by a non-authority → `Unauthorized`; `set_fee(n, zero key)` → `TreasuryUnset`;
- `set_fee(0, treasury)` → account 343 bytes, rent-exempt, treasury set, `FeeChanged` emitted, the rest of the
  config untouched;
- a different account in the treasury slot → `TreasuryMismatch`, with the fee at 0 and at 12,345;
- paused + fee → `Paused`, nothing moves; invalid proof + fee → `InvalidProof`, nothing moves and the
  nullifier stays unconsumed;
- a consume at fee 12,345 (current-vkey fixture): the treasury gains exactly 12,345, the recipient the amount,
  the source pays transaction fee + Nullifier rent + amount + 12,345; the Nullifier records transfer-gate;
- a replay at fee > 0 → `NullifierAlreadyConsumed`, nothing moves; `set_fee(0, treasury)` turns the fee off.
- Gated transfer: 270,300 CU with the verifiable binaries (270,247 with the local build; 0.7.x: 269,045 — the fee
  path adds one System transfer), 927-byte transaction (`tests/m2-metrics.json`).

`scripts/test-fee-migration.sh` (the deployed verifier binary, dumped from mainnet, loaded as an upgradeable
program) — **5 passing**:

1. the deployed program writes a 303-byte Config; `decodeConfig` reads it as fee 0 / no treasury; it does not
   know `set_fee`;
2. `solana program deploy` upgrades it in place to the 0.8.0 binary;
3. the new program reads the legacy account: `set_config` round-trips without resizing, the legacy fixture
   consumes at fee 0 with the fee payer in the treasury slot;
4. `set_fee(0, treasury)` grows the account 303 → 343 bytes; the Config gains and the authority pays exactly
   the rent difference (278,400 lamports at local rent; 203,200 on mainnet);
5. `set_fee(12,345, treasury)`, a consume moves exactly 12,345 lamports; a second `set_fee` on the grown
   account neither resizes nor moves rent.

Host: `cargo test --locked --manifest-path programs/Cargo.toml` (`programs/blindseal-verify/tests/config_layout.rs`);
SDK: `packages/sdk/test/fee-0.8.test.ts` (both Config layouts, `buildSetFeeIx`, the fee slots, `submit()`
reading the treasury).

## Client changes

- SDK: `decodeConfig` reads both layouts (`feeLamports`, `treasury`, `hasFeeFields`); `buildSetFeeIx`;
  `treasuryAccount`; `buildVerifyIx` / `buildGatedTransferIx` take `feePayer` / `treasury`; `readConfig`;
  `submit()` reads the Config and reports the fee through `onFee`. `CONFIG_SIZE_LEGACY` / `CONFIG_SIZE`.
- CLI `blindseal submit` prints `verifier fee: none` or `verifier fee: <n> lamports → <treasury>` before sending.
- Gated programs: forward `fee_payer` (a signer), `treasury` and `system_program` in the CPI (transfer-gate
  shows how); account lists in `programs/README.md`.
- New errors: `6015 TreasuryMismatch`, `6016 TreasuryUnset`. Existing codes keep their numbers.
