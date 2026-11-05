# Release 0.8.0 — execution record (Solana mainnet, 2026-11-05)

The plan is `docs/release-0.8.0-plan.md`. This file records what was sent, in order, with every signature.
Source commit for the programs and the prover: `eb864b9643477de775d37efec5b9d18907a09a7a` (branch `release/0.8.0`;
the prover release tag `prover-v0.8.0` sits at `df2f4ef`, which differs from eb864b9 only in docs and release
scripts). Signer for every admin step: the config / upgrade authority `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj`.
Every config step was simulated (`--simulate`) immediately before it was sent. Step d (authority hand-over to the
Ledger) stays skipped, as in 0.7.0.

Before anything was sent: the Config migration rehearsal (`scripts/test-fee-migration.sh` against the verifier
dumped from mainnet) passed 5/5, once with the source build and once with the verifiable-build bytes below; the
localnet suite (46 tests) passed on the verifiable bytes, including the published 0.7.1 client reaching the
upgraded verifier at fee 0 and being refused (`FeeAccountsMissing`) at fee > 0.

## Policy roots (on the 0.7.0 programs, before the upgrade)

| Step | What | Signature |
|---|---|---|
| b | register the default policy root `0x78bb3bab…b10a` (empty action policy) | `2A1z2DfbCYxGSVDxyUNfbS31thTKeJcyx5W7JZNBdyqEd8z2Hqz35m6aw7kFZYywEXPJaciyYtkqsJCJAZDarYNy` |
| b2 | register the demo policy root `0x79f11a12…ea8e` (the sample's) | `3ky3njXekfpqWMcJj4hk5wmqSDXdkZrPuoNuTHoQgsUPfNaKt5Wp1SKxfUxb7oZE6RU9FnQ6VK8vpS5vMqRs6hGP` |

## Programs

| Step | What | Signature | Slot |
|---|---|---|---|
| 0 | upgrade transfer-gate `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa` | `5sd9LjqGrzBzCiSogHb2E4KWGkT6C58sBh5bmZZauhZ5RG24Mq9DfcYciB2H3b4UEZmkptjDsgsLkRM7hhJ1oJSr` | 465,811,080 |
| 0 | upgrade blindseal-verify `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` (ProgramData extended 366,672 → 381,352 B) | `5pC9QKn87TwQM239BoqqkhzJVpt65T4oM9JWvbnWkJ1pnwCu68uYgGQ4V1qJrj1MA2C2AyWYtnV13FX57jV5y6QT` | 465,813,148 |

The verifier upgrade did not land in one go: the first attempt created and funded its buffer (and extended
ProgramData) in `4TEran3zkcCEHpupZV8F6jUmD8LDDdmFsqVbqVMusaqP7FjLniLHDK2JUanhoWW4F99prWL9naBug1aTL3jpo7yS`, then
every buffer write failed client-side ("Max retries exceeded" over the validator TPU path). The deploy was resumed
with that buffer (`--buffer`, writes sent over RPC with `--use-rpc`); the buffer was consumed and closed by the
upgrade and its rent refunded. Between the two program upgrades (about 8 minutes) the new gate called the old
verifier; at fee 0 the extra account lands in the old program's remaining accounts, so nothing broke.

The binaries are the `verifiable-build` workflow's artifacts (run 41899366602, `solanafoundation/solana-verifiable-build:4.3.0`,
native amd64), accepted by `scripts/mainnet-0.7.0.sh 0 --so-dir` only at the release hashes and checked again on chain:

| Program | executable hash | bytes |
|---|---|---|
| transfer_gate | `5d02435797e80ae99ab3600f5cae9f5b819b49de42c751ae69b0fc30c97dbc0b` | 188,808 |
| blindseal_verify | `95a7cd065535b73777a3ffd5b93f6e70c2d38f04021f3f1b0068f424fadc2167` | 381,352 |

On-chain verification records re-pointed to eb864b9 (`solana-verify verify-from-repo --skip-build`, then
`solana-verify remote submit-job`): gate `4uaLWdL7M9mH73u9T6HkTMrgJ88SfNfLdfPJc733ZbD4egNauwLA7ctGteMTM4vokuEA6zVKCzcM9dJyR8RefdzL`,
verifier `5JFgfke1BgLJo59Y3pKhYtK4oYHtNjM4xQE1QbWHMYvKjBVywr2nYCzM9zYJpVrApBYc4tnacLq6ztLNPMZH2Nbs`. The remote
verifier (verify.osec.io) reports both programs verified at that commit with the hashes above.

## Verifier config `9je2jP8yLogrSbm6qxDFjjQXKKwk9A25KMqwXCqDb4M3`

| Step | What | Signature |
|---|---|---|
| f | `set_fee(0, treasury = 88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj)` — Config 303 → 343 bytes, nothing charged | `3K5XoRjq3EwYiR4Wq3sPwEkHxoJrt7kWauwcVXZwDziEyf9w1m5SvgjSBFMW4wfGRBfG4wu29bwYnYJiEcaHMc1R` |
| c1 | allow the 0.8.0 vkey `0x00bd130c…0378` (0.7.0 kept) | `5zHZUtmFUVca4nTdoy9tiDcJtYJHet8Smtmesrb2Ua4DoF8HLdhZGhksu7RNrKKQgaYwaReeF5n6sijepiAapJXQ` |
| c2 | remove the 0.7.0 vkey `0x00cdf40c…2967` | `3uMEtyKTmYV6H11yvpdb7T3T3y65b8fBpXSMx5VgbqttwHMdAHi1UW4P1qz32LDvuGAbTmZJHdJVC2SA5HjPGr1h` |

The treasury is the authority itself (the plan allows it as a first treasury; no separate treasury account exists
yet). The first send of step f was refused at the RPC's preflight with empty logs while the step's own simulation
had passed; the retry landed. The RPC endpoint sits behind a load balancer whose nodes lagged a few seconds behind
each other throughout (a Config read right after a confirmed transaction returned the previous state twice).

## Sample proof (0.8.0 vkey, demo policy root)

| What | Signature |
|---|---|
| gated transfer through transfer-gate (`tests/fixtures/attestation-mainnet-demo-0.8.0.json`, 0.001 SOL from the demo wallet, slot 465,814,701) | `2fZ8TDPnfkHitJ4aHZzGuCu9mwkdBXLVm6LGWeMMwykQrWTNHNuXiDCeoXvi4HEChJ3xywKcF5kJkEcr4H7WvsCg` |
| the same attestation replayed → `NullifierAlreadyConsumed` (6006), sent without preflight so the rejection is on chain | `4TAvtbzu2NHPFqtXhEy3QCE8SeembSCa9Tu1UqNLkQKSa9eMzEjBpmTFdzzdNw6sPHR2YpUDanW7Mf6Q7mKdQvBw` |
| the 0.7.0 sample (`attestation-mainnet-demo-0.7.0.json`, old vkey) after c2 → `DisallowedVkey` (6001), sent without preflight | `4KaBaearkohhMVAeRfnxxwZJVQ7VeVKFSF5tqozeT9jDP9HJn7rRSsZvHYT51Zs2JBckQWRwtePyMpXhUHiH2quz` |

The replay and the old-vkey rejection were also shown through `blindseal submit`, which the RPC preflight refused
with the same two error codes.

## Prover 0.8.0

GitHub release `prover-v0.8.0`. All three binaries embed the committed guest ELF `crates/guest/elf/blindseal-guest`
(sha256 `859af59ddb7b9ec47fc48c11e9fa6155d038d837e3c991d18caf2af95461729c`, 503,880 bytes), whose verifying key is
the 0.8.0 vkey.

| Asset | sha256 |
|---|---|
| blindseal-prover-darwin-arm64 (built on an Apple M1 Max, `cargo build --release --locked`) | `73663623a2b56c487926f09345acd8a794e0f0a798d5d2857a7273bc89e809dc` |
| blindseal-prover-linux-x64 (prover-linux workflow, run 42089535106) | `fd98c743e44cbaaaa75c744ee5dad75a5d79992150180e253122dffe0396e0d4` |
| blindseal-prover-linux-x64-cuda (same run; builds without a GPU, proving needs one) | `e8b3f5fcfe42cf7ef5d34e6c73fd3a0f7d12c3219810c8ead7b8d07c047714ce` |

`packages/proxy/src/prover/manifest.json` pins these (commit `cc7bea5`). CI's pinned-asset job reproduces the
sample's public values with the linux-x64 and linux-x64-cuda binaries; the same check passed locally for darwin-arm64.

## npm

| Package | shasum |
|---|---|
| blindseal-sdk@0.8.0 | `1f1de8e7fc840d85843729ce2ca8f10da1a5e0cb` |
| blindseal@0.8.0 | `03557f1eea2a84717662ae1d903b6e3f015bcf07` |

Fresh npm-only install (empty directory, its own HOME): `blindseal verify` on the sample → VALID with the action
binding; `blindseal submit --check` → CONSUMED; `blindseal attest` with the demo action policy downloaded the pinned
darwin-arm64 prover (sha256 above) and, run in executor-only mode, reproduced VKEY `0x00bd130c…0378` and the demo
policy root.

## Cost

Authority balance 3.142801868 → 3.063173805 SOL (ProgramData growth rent 0.0745744, two policy-root registrations
0.0017983, deploy and config fees, two verification-record updates). Demo wallet 0.01585156 → 0.01377484 SOL (one
gated transfer of 0.001 SOL, nullifier rent, two rejected transactions' fees).
