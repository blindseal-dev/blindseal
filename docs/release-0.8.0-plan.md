# Release 0.8.0: mainnet plan (read before signing)

Release 0.8.0 moves L0 (decode-then-L1) into the proof. The guest changed, so the proof's verifier key
(`detectorVersion`) changed; the on-chain allowlist has to admit the new key before an 0.8.0 attestation
can be consumed. Nothing in this release changes the public-input layout, the action hash, the nullifier,
the Config / PolicyRoot / Nullifier accounts or the gate's CPI, so no program upgrade is needed for the
new key. (The fee switch, branch `feat/verifier-fee`, is a separate upgrade with its own document,
`docs/release-0.8.0-fee-switch.md`.)

The steps reuse `scripts/mainnet-0.7.0.sh` (helper `scripts/lib/mainnet-admin-0.7.0.mts`): its `c1`
adds the SDK's `CURRENT_VKEY` to the on-chain list and its `c2` removes `LEGACY_VKEYS`, both read from
`packages/sdk/src/ix.ts`, which this release re-pins. Run every step with `--simulate` first.

Nothing was sent to mainnet or devnet while preparing this release.

| | |
|---|---|
| Guest ELF (`crates/guest/elf/blindseal-guest`) | sha256 `3363ab04a899e8eb1d519ea75d7bbe630c5b3d2bce850fb6b8ddde91f64b464f`, 463,876 bytes, built with `cargo prove build --docker --tag v5.0.0` |
| New vkey (`CURRENT_VKEY`) | `0x00e9807a48c66829ce5297a0c3b423cf724b8e47d21fbd98f50b5fcb51e4a537` |
| Previous vkey (now `LEGACY_VKEYS[0]`) | `0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967` (0.7.0) |
| Policy root the new sample commits | `0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397` (the registered default root; the widened L1 rules of `feat/l1-rules-0.8` produce a NEW root that is registered separately, see "Sign list") |
| Executor cycles, mainnet sample | 104,291,669 (0.7.0 guest: 104,223,540) |
| CPU proof of the mainnet sample (M1 Max, 32 GB, alone) | 2 h 20 min 38 s (8,438,066 ms; 0.7.0: 8,740,766 ms) |
| New sample | `tests/fixtures/attestation-mainnet-demo-0.8.0.json`: the same tool call as the 0.7.0 sample (`tests/fixtures/mainnet-toolcall-demo.json`, payloadHash `0x7de7653d…47dec`), expiry slot 465,653,982, nonce fresh. Verified off chain with `blindseal verify` (proof, labels, action binding). NOT submitted. |
| Authority, fee payer and signer | `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj` |

## What the proof now claims

Before 0.8.0 the guest asserted L1 on the raw payload. From 0.8.0 it also asserts L1 on every decoded
variant of the payload: base64 blobs, hex runs, URL-percent runs, HTML numeric entity runs, the text with
zero-width characters removed, its NFKC normalization, and a homoglyph fold (Cyrillic/Greek look-alikes to
ASCII), nested to depth 3 — exactly what the proxy's `runLayer0` checks before `blindseal attest` starts
the prover. The parity gate (`evals/vectors/parity.json`, 718 vectors) ties the TypeScript reference, the
Rust host path and the guest's serialized-DFA path together; `crates/prover/tests/guest_l0.rs` executes the
committed guest on encoded injections and checks it refuses each one with "L0 did not pass".

## Sign list, in order

1. **Register the widened policy root** — `scripts/mainnet-0.7.0.sh b` after merging `feat/l1-rules-0.8`
   (it re-pins `DEFAULT_POLICY_ROOT`; the step registers whatever the SDK pins and is a no-op if already
   registered). Rent 899,160 lamports + 5,000 fee. The old root stays registered, so attestations under it
   (including the 0.8.0 sample proven tonight) stay consumable.
2. **Upgrade the verifier with the fee switch (fee 0)** — per `docs/release-0.8.0-fee-switch.md` (both
   programs; `set_fee(0, treasury)` performs the Config realloc). Independent of the vkey change; can also
   run after step 5.
3. **c1: allow the new vkey** — `scripts/mainnet-0.7.0.sh --simulate c1`, then `c1`. Sends one
   `set_config(allowed_vkeys = [0x00cdf40c…, 0x00e9807a…a537])`:
   - program `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`, accounts Config `9je2jP…` (writable), authority
     `88sR7X…` (signer); data `6c9e9aafd4623442 01 02000000 <0.7.0 vkey> <new vkey> 00 00`; fee 5,000
     lamports, no rent (Config is fixed size).
4. **Re-prove and consume** — if the sample's expiry slot 465,653,982 is still ahead of the current slot,
   consume `tests/fixtures/attestation-mainnet-demo-0.8.0.json` directly: `blindseal submit <file>`
   (through transfer-gate, the demo wallet `GdPZNkh4…` signs the 0.001 SOL transfer as in 0.7.0). If it
   has expired, re-prove the same tool call first (`blindseal attest`, GPU: minutes; CPU: 2 h 20 min 38 s)
   and consume that. Then `blindseal submit --check` must report CONSUMED.
5. **c2: drop the 0.7.0 vkey** — `scripts/mainnet-0.7.0.sh --simulate c2 --new-sample <consumed 0.8.0
   attestation>`, then `c2`. The step refuses unless the sample is under the new vkey and consumed, and
   unless the prover manifest points at an 0.8.0 release — so **publish the prover-v0.8.0 release and
   re-pin `packages/proxy/src/prover/manifest.json` (version, assets, `guestElf`) before c2**; until then
   `blindseal attest` downloads prover 0.7.0 (old guest, old vkey) whose proofs c2 would make unconsumable.
   After c2 every 0.7.0 attestation fails with `DisallowedVkey` (6001), including the site's current sample —
   swap `/verify`'s sample and the how-it-works fixture to the 0.8.0 attestation in the same site release.
6. **Fund the dogfood wallet and start the timer** — per `services/dogfood/README.md` (branch
   `feat/dogfood`): create the wallet outside the repo, fund it with the daily caps' worth of SOL and USDC,
   set `BLINDSEAL_DOGFOOD_WALLET` for the site so the explorer labels and excludes it, start the loop.

## Preconditions the script checks

- `c1` refuses unless `allowlist_policies` is true (done in 0.7.0) and the list stays within 8 keys (it
  will hold 2).
- `c2` refuses unless `c1` landed, the sample is under `CURRENT_VKEY` and consumed, and the manifest is
  at least 0.8.0.
- Both steps are plain `set_config` calls signed by the config authority; 5,000 lamports each.

## After the morning

- Release `prover-v0.8.0`: darwin-arm64 built on the Mac from the release commit, linux-x64 (and
  linux-x64-cuda, branch `feat/gpu-prover`) from the `prover-linux` workflow on the tag; update
  `manifest.json` (`version`, `release`, each asset's sha256, `guestElf.sha256`/`bytes` = the committed
  ELF). CI's `prover-asset` job then checks the committed ELF is the embedded one again.
- Publish `blindseal` / `blindseal-sdk` 0.8.0 (not tonight).
- Site: numbers marked "pending mainnet" (scope, how-it-works) lose the marker once c1 and the register
  step have landed.
