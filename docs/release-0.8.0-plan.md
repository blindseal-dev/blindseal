# Release 0.8.0: mainnet plan (read before signing)

Release 0.8.0 changes what the proof asserts and adds a fee switch to the verifier:

- **The guest** runs L0 (decode-then-L1) and L1 on the raw payload **and on every JSON string in it** (keys and
  values, unescaped, any depth), and checks the bound action against a **stateless action policy** (allowed
  recipients, a maximum amount, allowed programs, instructions and mints). New detector version (vkey), new
  policy roots: `policyRoot = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash)`.
- **The verifier** gains `set_fee` and optional trailing fee accounts; a 0.7.1 client keeps working at fee 0
  (`docs/release-0.8.0-fee-switch.md`). **transfer-gate** expects the new roots and forwards the fee accounts.

Every step goes through `scripts/mainnet-0.7.0.sh` (helper `scripts/lib/mainnet-admin-0.7.0.mts`), which reads the
SDK's pins (`CURRENT_VKEY`, `LEGACY_VKEYS`, `DEFAULT_POLICY_ROOT`, `DEMO_POLICY_ROOT`). Run each config step with
`--simulate` first. Nothing in this document was sent to mainnet or devnet.

| | |
|---|---|
| Guest ELF (`crates/guest/elf/blindseal-guest`) | sha256 `859af59ddb7b9ec47fc48c11e9fa6155d038d837e3c991d18caf2af95461729c`, 503,880 bytes; CI's `guest ELF reproduces from source` job rebuilds it byte for byte with `cargo prove build --docker --tag v5.0.0` |
| **New vkey** (`CURRENT_VKEY`) | `0x00bd130c8d3ccc302df81ae4a422c3bd7a9f8d56afccfa4eb934d4e4406e0378` |
| Still allowed until c2 (`LEGACY_VKEYS`) | `0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967` (0.7.0). The 0.6.0 key is listed for the localnet fixtures only; it is not on chain. Last night's `0x00e9807a…a537` (before string screening) is discarded and never allowed. |
| Rules root (unchanged: the 22 committed L1 rules) | `0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397` — also the registered 0.7 policy root |
| **New default policy root** (empty action policy) | `0x78bb3bab1765304373a6af9de2d7c081ce57bc862c039f6dd682c74e939eb10a` |
| **Demo policy root** (the sample's) | `0x79f11a126ef624b03a351efc79747ee6dadcac8eab71f5e24061514e6205ea8e` = rules root + `tests/fixtures/action-policy-demo.json` (the demo recipient `6HwAr9…mXo` only, at most 10,000,000 lamports = 0.01 SOL); actionPolicyHash `0xe8914f8815f52443ef2c046006f50f5cf3cb45c4671745f95d6f0bcb6377d9f9` |
| **Sample** | `tests/fixtures/attestation-mainnet-demo-0.8.0.json`: the 0.7.0 sample's tool call (payloadHash `0x7de7653d…47dec`, 0.001 SOL from the demo wallet `GdPZNkh4…` through transfer-gate), actionHash `0x275ee51c…4355`, nullifier `0x36b36c1b…a62d`, **expiry slot 466,872,143** (≈ 7 days after 2026-11-04 16:39 UTC). Verified off chain (CLI and SDK: proof, labels, action binding). Not submitted. |
| CPU proof of the sample (Apple M1 Max, 32 GB, alone) | **8,366,102 ms = 2 h 19 min 26 s**; executor 104,486,030 cycles (0.7.0: 104,223,540) |
| GPU proof | not measured (no GPU host available); procedure in `docs/gpu-proving.md` |
| Programs (verifiable builds, `solanafoundation/solana-verifiable-build:4.3.0`, workflow `verifiable-build` at the release commit) | transfer_gate {{GATE_BYTES}} B, executable hash `{{HASH_GATE_080}}`; blindseal_verify {{VERIFY_BYTES}} B, executable hash `{{HASH_VERIFY_080}}` |
| SIMD-0500 (`B8JJXCy5…o83g`) | read 2026-11-04 19:18 UTC: not activated and not pending, so the 4.3.0 image (sBPF v0) still deploys. Re-check on the day. |
| Authority, fee payer and signer | `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj` |

## Sign list, in order

1. **Register the policy roots** — `scripts/mainnet-0.7.0.sh --simulate b`, then `b` (registers
   `DEFAULT_POLICY_ROOT` 0x78bb3bab…), then the same for `b2` (`DEMO_POLICY_ROOT` 0x79f11a12…, the sample's root).
   Each is one `register_policy_root` transaction: 899,160 lamports rent + 5,000 fee. Works on the 0.7.0
   programs. The 0.7 root stays registered, so 0.7.x attestations keep their root until c2 retires their vkey.
2. **Upgrade transfer-gate** — `scripts/mainnet-0.7.0.sh 0` builds both programs with the verifiable image; check
   that its local executable hash for `transfer_gate` is `{{HASH_GATE_080}}` before typing the confirmation. The
   new gate expects the default, demo and 0.7 roots and forwards the optional fee accounts; a 0.7.1 client
   (no treasury account) keeps working. ProgramData {{GATE_GROWTH}}.
3. **Upgrade blindseal-verify** — same step, `blindseal_verify` must hash to `{{HASH_VERIFY_080}}`.
   ProgramData {{VERIFY_GROWTH}}. Either upgrade order works at fee 0 (the old gate's CPI omits the trailing
   fee accounts, which the new verifier accepts while the fee is 0); gate first as in 0.7.0.
4. **`set_fee(0, <treasury>)`** — `scripts/mainnet-0.7.0.sh --simulate f --treasury <pubkey>`, then `f`. Grows
   Config 303 → 343 bytes (+203,200 lamports rent, paid by the authority) and records the treasury; charges
   nothing. The step refuses unless the deployed programs are the 0.8.0 builds. The treasury must be an existing
   rent-exempt account; the authority itself is a fine first treasury.
5. **c1: allow the new vkey** — `--simulate c1`, then `c1`. One `set_config(allowed_vkeys = [0x00cdf40c…,
   0x00bd130c…])`: data `6c9e9aafd4623442 01 02000000 <0.7.0 vkey> <0.8.0 vkey> 00 00`, 5,000 lamports, no rent.
6. **Consume the sample** — `blindseal submit tests/fixtures/attestation-mainnet-demo-0.8.0.json` (the demo wallet
   signs; either the 0.7.1 or the 0.8.0 CLI works at fee 0), then `blindseal submit --check` → CONSUMED. Must land
   before slot 466,872,143.
7. **npm 0.8.0** — `blindseal-sdk` then `blindseal` (`cd packages/<p> && pnpm publish --access public
   --no-git-checks`); `scripts/npm-pack-audit.sh` clean first; fresh-install check as in 0.7.1.
8. **prover-v0.8.0 + manifest** — tag `prover-v0.8.0` at the release commit: darwin-arm64 built on the Mac,
   linux-x64 and linux-x64-cuda by the `prover-linux` workflow; set `packages/proxy/src/prover/manifest.json`
   (`version`, `release`, each asset's sha256, `guestElf` = sha256 `859af59d…729c` / 503,880 bytes). CI's
   `prover-asset` job must then reproduce the sample's public values with the released binary.
9. **c2: drop the 0.7.0 vkey** — `--simulate c2 --new-sample tests/fixtures/attestation-mainnet-demo-0.8.0.json`,
   then `c2`. Refuses unless the sample is under `CURRENT_VKEY` and consumed and the manifest is ≥ 0.8.0. Data
   `6c9e9aafd4623442 01 01000000 <0.8.0 vkey> 00 00`. After it every 0.7.x attestation fails with
   `DisallowedVkey` (6001) — which retires the JSON-escape gap of all proofs before 0.8.0.
10. **Site sample** — swap `/verify`'s "Try a sample proof" and the how-it-works fixture to the consumed 0.8.0
    sample (with its consume signature), remove the "pending mainnet" markers, deploy.

Then, separately: fund the dogfood wallet and start its timer (`services/dogfood/README.md`).

## What is not in this release

- The widened L1 rule set (PR #9) is closed: about 20-hour proofs, and its 93.5 % was measured on the set its
  rules were written against. The 22 rules stay; the honest numbers, measured as the proof sees them, are in
  `evals/results/catch-rate-0.8.0.md` (true holdout 2.5 %, red-team set 29.0 %, benign false positives 0.5 %).
- Per-owner policy roots: a 0.9 design (`docs/design/per-owner-policy-roots.md`), no program change now.
