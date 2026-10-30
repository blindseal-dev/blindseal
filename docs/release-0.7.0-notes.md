# Release 0.7.0 — execution record (Solana mainnet, 2026-10-30)

The plan is `docs/release-0.7.0-mainnet-plan.md`. This file records what was sent, in order, with every signature.
Source commit for the programs and the prover: `5cef6beb0892f3dcd2d860a1d9d1bbfc252103d7` (branch `release/0.7.0`).
Signer for every admin step: the config / upgrade authority `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj`.
Every step was simulated (`--simulate`) immediately before it was sent. Step d (authority hand-over to the
Ledger) was skipped by decision of the owner; the authority stays with the key above.

## Programs

| Step | What | Signature | Slot |
|---|---|---|---|
| 0 | upgrade transfer-gate `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa` | `4CP4dquvsbnC3Su8aAfRt6Hn3PFbHMqNTQT5Znq2sz9KFqJrSxw5PaAdcgjRnEG4rSg2atK9JSR4VaYaXbKZqqcS` | 463,413,826 |
| 0 | upgrade blindseal-verify `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` | `3f97M7MKXmzu9qZvvPCj3tp59mLDDmVmTpLuj2KGmwWM1qSs8iYJ6BnKVG46ZiVK1tYzYugxUDeHWkYa8hMMkdXs` | 463,414,112 |

Deployed executable hashes, equal to the verifiable builds (`solanafoundation/solana-verifiable-build:4.3.0`) of 5cef6be:

| Program | sha256 |
|---|---|
| transfer_gate | `a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86` |
| blindseal_verify | `5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed` |

Reproduced two ways from the public repository: `solana-verify verify-from-repo … --commit-hash 5cef6be…` reports a match
for both, and a fresh clone built with `solana-verify build` gives the same two hashes. The on-chain verification records
(PDAs `fNuf9M6L7wdRYv79BBK8mGN7EXDEX1BCyJZuahD5Ehb` for the gate, `BG72hZ7F9nxgtXD77tJ3AWKHC5Pwx74x5VdiwWRzLy7x` for the
verifier) were updated from the 0.6.0 commit to 5cef6be: `59sJKXPv2rS3xsLt3YKVgvTUyDskRVoYwJGthmDg4gEB997B4fmzB2Eo8CtgS6e7cobeXkC2hUpSE5XdxXY1KF4n`
(gate) and `5NYUMkmnamN3MrLqoTx8rTPeHckJeBvpZQVkfk9QLnc86TEhFqG9wu6KRVWjKQxFb1SC7ZbFtWzR4UbgtajEu8zm` (verifier).

## Verifier config `9je2jP8yLogrSbm6qxDFjjQXKKwk9A25KMqwXCqDb4M3`

| Step | What | Signature |
|---|---|---|
| b | register the default policy root `0x36a9e9…8397` | already registered (`9XfreXFvq3TyQywnbjjKPNRV8FDxegzEZPj4DtMLe3CC`), nothing sent |
| a | `allowlist_policies` false → true | `2KyzaXuJG8ECvKaycCzgYG5ZV2svtaBVBwDVqMTkZZG5AyUGbDcf1nUGEg73v1nMxmFHfRvAQEzrfFCvJpgfYNQE` |
| c1 | allow the 0.7.0 vkey `0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967` (old one kept) | `JqLSrTT5R9mb3fBNyoiBh6SfHQDhKt6XBLwpR6rZwDBEDGgZRESwWpy6mccBPTVWC9cibWnvyMyf3KbVJUN8k34` |
| c2 | remove the 0.6.0 vkey `0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e` | `3dq3nyYygVu9GfWY2o1Jn1Wn7qQhWUhWfxDiiEASsE1iMPQuWSA1Xeu8se88YrgsNByDmZR3NsoCMWNJjfyaqang` |
| d | hand the authority to the Ledger | skipped |

Config after c2: `allowedVkeys = [0x00cdf40c…9f2967]`, `allowlistPolicies = true`, `paused = false`.
(The helper's "Config after" line printed for c2 was a stale read from the RPC and still showed both vkeys; a
re-read a few seconds later, and every later simulation, shows the single vkey.)

## Sample proof under the 0.7.0 vkey

`tests/fixtures/attestation-mainnet-demo-0.7.0.json`: the demo tool call `tests/fixtures/mainnet-toolcall-demo.json`
(a 1,000,000-lamport transfer from the demo wallet `GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L`) proven with prover 0.7.0
in 8,740,766 ms (2 h 25 min). Expiry slot 463,600,736; the margin at consume time was 154,440 slots.

| What | Signature |
|---|---|
| gated transfer through transfer-gate (nullifier PDA `93TrvmVrV41y8pQWyWeHK8zyd8zEDX6iGxCAstZ8cDeq`, slot 463,446,579) | `2HrABCZYnaHk66gmg9yi3mB27t487mpF6HgZMgbQJcxBhTm2L7nr1P2BbHPd46gHQWAvscAuJCTTGHtQz5mCFj26` |
| the same attestation replayed → `NullifierAlreadyConsumed` (6006) | `5QZZyttkpnWoCPd7sAh2n2FJqo9hsfq74b67acJSZsT65qWptRExJmum3LNeajSXfZVZ2Gk1G3WMN6hs4fvaK4Rg` |
| the 0.6.0 sample (`attestation-mainnet-demo.json`, old vkey) after c2 → `DisallowedVkey` (6001) | `5wNf1fr5aQw5MUqNwyLHndJR378kdrNN4V426WZtJG4T3Azn6S3oXtK9dGaiNtrMbhJdqikcucYuRRxrHUrjQUWC` |

The old-vkey rejection was shown three ways: a simulation, `blindseal submit` (refused at the RPC preflight with the same
log), and the transaction above, sent without preflight so the rejection is on chain.

## Prover 0.7.0

GitHub release `prover-v0.7.0` (tag at 5cef6be). Both binaries embed the committed guest ELF
`crates/guest/elf/blindseal-guest` (sha256 `dd3c49340646af0a249851d6f14afccc21d52bf1cd40610308420ced241899db`), whose
verifying key is the 0.7.0 vkey.

| Asset | sha256 |
|---|---|
| blindseal-prover-darwin-arm64 | `ac2e2ea14568d27bceff0d7b696ae38023a32ea4c42d132efda5fae890eeb4eb` |
| blindseal-prover-linux-x64 (prover-linux workflow, run 41135822191) | `798b214502c85b98364f1db9ed6e012965317fba137f65fc28c26907d2f07a35` |

`packages/proxy/src/prover/manifest.json` pins these (commit `0946d2f2d06a3df358188c29eb5293cbe3bc7703`, the only change to
a package source after 5cef6be).

## Cost

Authority balance 3.197621665 → 3.142801868 SOL (program-data growth rent, buffer fees, four config transactions, two
verification-record updates). Demo wallet 0.01792828 → 0.01585156 SOL (one gated transfer of 0.001 SOL, nullifier rent,
two failed transactions' fees).
