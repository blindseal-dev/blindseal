# Blindseal — performance (real numbers only)

Estimates are not allowed here. Every row is filled from an actual run on a named machine.
Updated at the end of M0.5, M1, and M2.

## Reference machine
- Apple Silicon, macOS 27 (arm64), 10 CPU cores, 32 GB RAM.
- Docker Desktop memory raised to 24 GB for the Groth16 wrap (see M0.5 notes).

## M0.5 — verifier spike (SP1 Groth16 -> Solana via sp1-solana) — GREEN (real CU measured on localnet)

A minimal SP1 guest (sha256 a few bytes, commit the digest) was proven to a local Groth16
proof and **verified on the Solana runtime** through `sp1-solana` (`GROTH16_VK_5_0_0_BYTES`,
alt_bn128 syscalls), via `solana-program-test`. The throwaway spike code is not part of this repository.

### Version matrix (the whole point of M0.5)
| Component | Version | Note |
|---|---|---|
| sp1-sdk (host facade) | 5.0.0 (pinned `=5.0.0`) | caret `"5.0.0"` resolved to 5.2.4 — pinned exact |
| sp1-zkvm / sp1-build | 5.0.0 | guest + build |
| SP1 internal crates (sp1-prover, sp1-core-\*, sp1-recursion-gnark-ffi, sp1-stark, sp1-verifier) | **5.2.4** | caret-resolved; sp1-sdk 5.0.0 pulls them at ^5.0.0 |
| SP1 succinct toolchain | v5.0.0 (rustc 1.85.0-dev) | `sp1up --version v5.0.0` |
| Groth16 circuit / docker image | **v5.0.0** | `ghcr.io/succinctlabs/sp1-gnark:v5.0.0`, `v5.0.0-groth16.tar.gz` |
| sp1-solana | 0.1.0 | verify key `GROTH16_VK_5_0_0_BYTES` |
| solana-program / -sdk / -program-test | 2.1.6 | |
| Solana CLI (Agave) | 4.3.1 | |
| Host driver — guest build | Rust 1.85.0 | matches the succinct toolchain's rustc |
| Host driver — script build | Rust 1.99.1 | sp1-sdk's tree requires rustc ≥1.90 |

**Decision — pin to the SP1 5.0.0 series:** `sp1-solana` 0.1.0 ships Groth16 verifying keys
only through `GROTH16_VK_5_0_0_BYTES`. The Groth16 wrapper circuit is stable across the 5.x
series (the internal crates are 5.2.4 yet the gnark circuit/docker image is `v5.0.0`, and the
proof verifies against the 5.0.0 key), so this is a deliberate pin to the newest supported
version, **not** a silent downgrade.

### Measured results
| Field | Value |
|---|---|
| Program verification-key hash (`vk.bytes32()`) | `0x0097cb8781a7e6c5d286471c3df6108fd023e78632fe4e86f93cb99b8b8aaf06` |
| Groth16 VK matched | `GROTH16_VK_5_0_0_BYTES` |
| On-chain verify result | **VERIFIED** (`VERIFY_OK true`) |
| Tampered-input case | **rejected** (`NEGATIVE_REJECTED true`) — the pass is non-vacuous |
| Proving time (core + Groth16 wrap) | **255,941 ms (~4.3 min)** |
| Peak host RSS | **5.49 GB** host. The gnark container OOM-killed at Docker's 7.7 GB default and succeeded at 24 GB; the container's own peak was not sampled. |
| Groth16 proof size | **260 bytes** |
| Public-input size | **36 bytes** |
| Transaction size (signed, serialized) | **545 bytes** |
| Verify compute units (program-test, native) | not metered (native processor) |

### Localnet verification — real compute units (2026-10-22)

Deployed `blindseal-m05-program` (`cargo build-sbf`, BPFLoaderUpgradeab1e) to a real
`solana-test-validator` and sent the SP1 v5 Groth16 verify instruction with the committed proof
(the spike's localnet script).

| Field | Value |
|---|---|
| Harness | solana-test-validator (localnet, SBF VM) — real metering |
| On-chain verify | **VERIFIED** on localnet (a proof from our own guest) |
| Tampered-input case | **rejected** (non-vacuous) |
| **Verify compute units** | **227,375 CU** (measured via `simulateTransaction`) |
| Compute-unit limit requested | 1,400,000 (default 200k is exceeded — a `ComputeBudget::set_compute_unit_limit` ix is required) |
| Transaction size (signed; budget ix + verify ix) | **584 bytes** |
| Groth16 proof size | 260 bytes |
| Public-input size | 36 bytes |
| Groth16 VK | `GROTH16_VK_5_0_0_BYTES` |

**Finding:** on-chain Groth16 verification costs ~227k CU and must raise the compute-unit limit
above the 200k default; a consumer program that gates on an attestation budgets ~230k CU plus its
own logic. This closes the M0.5 CU gap that program-test (native processor) could not measure.

### Caveats / follow-ups
- **Compute units — not captured; blocker named.** `solana-program-test` with a native
  `processor!` does not meter BPF CU. Building the program to SBF succeeds
  (`cargo build-sbf`, sbpfv3), but `solana-program-test` 2.1.6 then reports the sbpfv3 `.so`
  as "Program is not deployed" (a loader-version mismatch with Agave 4.3.1's build-sbf, tried
  via both `ProgramTest::new(..., None)` and `add_upgradeable_program_to_genesis`). A
  representative CU therefore needs a real `solana-test-validator` deploy — deferred to **M2**,
  whose "Done when" already records real `verify_and_consume` CU. Public sp1-solana references
  cite ~105k–300k CU for a Groth16 verify.
- **Groth16 artifacts:** the 5.0.0 circuit artifacts (`groth16_pk.bin` 2.7 GB, `groth16_circuit.bin`
  1.1 GB, `groth16_vk.bin`) were fetched from
  `https://sp1-circuits.s3-us-east-2.amazonaws.com/v5.0.0-groth16.tar.gz` into
  `~/.sp1/circuits/groth16/v5.0.0/`. The auto-download skipped (the sp1-sdk-5.0.0 path check vs
  the 5.2.4 prover's versioned mount path), so they were placed manually.
- **Docker memory:** the gnark Groth16 wrap OOM-killed at Docker's default 7.7 GB on 8.38 M
  constraints; raising Docker Desktop to 24 GB fixed it.
- **Reproducing:** the spike was superseded by `crates/guest`, `crates/prover` and `programs/blindseal-verify`;
  the SP1/Solana toolchains and the 3 GB circuit artifacts are machine-local.

## M1 — attestation engine
<!-- end-to-end proving time + RAM for a real fixture decision -->
_TBD_

## M2 — Solana verifier
<!-- verify_and_consume CU (real SBF/validator), with/without policy allowlist -->
_TBD_

## M1 — attestation engine (real detector-core guest)
First end-to-end proof from the real guest (minimal: L1 only, commits payloadHash). Reference machine as above.
| Field | Value |
|---|---|
| detectorVersion (guest vkey) | 0x007e7ae67b43fa8e96f6e5f6e8af5daaf9f9c40007ea1901cb23adbd6b5bc552 |
| policyRoot | 0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397 (matches detector-core::policy_root) |
| Proof size | 260 bytes |
| Public-input size | 32 bytes (payloadHash) |
| **Proving time** | **~4,396,765 ms (~73 min)** — see concern |
| Peak host RSS | 11.6 GB |

**Concern — proving is slow.** Running 22 serialized DFAs in-zkVM is ~17x the trivial M0.5 guest (~4 min). The likely bulk is `dense::DFA::from_bytes` validation per rule. Mitigations before adding L0 (which adds decoder DFAs + nested runs): use `from_bytes_unchecked` (sound — the policy DFAs are our own committed bytes), and iterate guest logic with `ProverClient::execute` (cycle count, no proof) rather than full proves. The spec (§3.5) anticipates slow async proving and the M4 TEE prover; 73 min still argues for the matcher optimization.

### M1 guest perf iteration (execute mode)
`from_bytes_unchecked` applied (sound — committed policy bytes). L1-only guest cycle count via
`BLINDSEAL_EXECUTE=1` (SP1 executor, no proof): **77,572,157 cycles**. Use `execute` to iterate
guest logic in seconds; prove only to checkpoint (full proof wall-clock re-measure pending).

### M1 full guest (L1 + action binding) — execute
Guest now recomputes payloadHash + policyRoot, runs L1 (serialized), binds the action
(actionHash + nullifier), commits 6 public values. Cycle count (execute): **346,102,430**
(up from 77.6M L1-only — the in-zkVM policyRoot merkle over ~22 DFA byte-blobs dominates).
Optimization: patch sha2 with the SP1 sha256 precompile to cut the hashing cost. Validated
public values: policyRoot = 0x36a9e9… (matches detector-core), detectorVersion = guest vkey.

### M1 full guest + sha256 precompile — execute
Patched sha2 with the SP1 sha256 precompile (tag patch-sha2-0.10.8-sp1-4.0.0; min SP1 4.0.0,
compatible with our 5.0.0). Full guest cycle count (execute): **104,155,812** (down from 346M,
~3.3x). policyRoot still 0x36a9e9… (correct). Proving is proportionally faster; the remaining
cost is the policyRoot merkle over the DFA byte-blobs.

## M2 — on-chain verify + consume on localnet (2026-10-23, measured)

Source: `tests/m2-metrics.json`, written by the happy-path test in `tests/m2.spec.ts`
(`scripts/test-m2.sh`: Agave 4.3.1 `solana-test-validator`, programs genesis-loaded at their
fixed ids). Numbers are from `simulateTransaction` on the exact transaction that was then sent.

| Metric | Value | Notes |
|---|---|---|
| Gated transfer, whole tx | **268,973 CU** | ComputeBudget ix + `transfer_gate::gated_transfer` → CPI `verify_and_consume` → system transfer. With the caller check (2026-10-27: stack height + instructions-sysvar read of the top-level program); 262,507 before it (267,055 in the last committed metrics) |
| `verify_and_consume` alone (inside the CPI) | ~254,300 CU | pre-caller-check figure, not re-measured; from the program logs; M0.5's bare Groth16 verify was 227,375 — the delta is the actionHash + nullifier recompute (2 × sha256), the Nullifier PDA creation and the `Consumed` event |
| Transaction size | **926 bytes** (893 before the instructions-sysvar account) | 260-byte proof + 168-byte public inputs + 178-byte action args + 32-byte nonce + accounts |
| Proof / public inputs | 260 B / 168 B | SP1 v5 Groth16 (bn254); 5×32 commitments + u64 expiry |
| Prove time (localnet test proof) | 8,250,797 ms (2 h 17 m) | CPU prover on this machine (`proveMs` in the fixture); unchanged from M1 |
| Compute budget to request | **400,000 CU** | SDK default (`VERIFY_CU_LIMIT`); the 200k default is exceeded |

Program ids (localnet = mainnet): verifier `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`,
transfer-gate `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa`. Pins: anchor 0.31.1, sp1-solana 0.1.0
(`GROTH16_VK_5_0_0_BYTES`), SP1 5.0.0. Mainnet figures follow.

### Mainnet (2026-10-23)
The acceptance transaction `7iwA4nxn…` — verify + consume + 0.001 SOL through `transfer-gate` —
consumed **259,324 CU** on mainnet-beta with an 893-byte transaction; the replay `42QVDVFj…` failed at step 6
after 8,176 CU in the verifier (`NullifierAlreadyConsumed`). Program rent: verifier 2.29 SOL, gate 1.18 SOL.
