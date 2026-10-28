# Security policy

Blindseal's on-chain programs — `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` (verifier) and
`9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa` (transfer-gate example) — carry a
[neodyme security.txt](https://github.com/neodyme-labs/solana-security-txt) that points here.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Email **blindseal@proton.me** (or open a private
GitHub security advisory on this repository). Include what is affected, how to reproduce it (payload,
config, environment) and any mitigation you suggest. We acknowledge within 72 hours and publish a fix
before details, with credit if you want it.

## Scope

In scope:
- The on-chain programs: proof verification, the check order documented in
  `programs/blindseal-verify/src/lib.rs`, nullifier (replay) protection, the
  policy-root and vkey allowlists, upgrade/pause authority handling.
- The SP1 guest and prover (`crates/`): anything that lets an attestation be produced for a call the
  committed policy would not pass, or for a payload that does not describe the action the proof binds, or
  that leaks the payload through the public inputs.
- The proxy and its local API: prompt-injection bypasses of L0/L1 in `block` mode (on tool replies or
  tool-call arguments, including batches), redaction failures for the listed secret and PII types (they
  reach L2/L3 unredacted), content reaching the audit log or scan history in plaintext, audit-chain or
  disclosure forgery, dashboard token handling.
- The SDK and the wasm verifier: accepting an invalid attestation or disclosure.

Out of scope:
- Detection evasion in `warn` or `log` mode (those modes let traffic through by design), and evasion of
  L2/L3 — the model-based layers are attested, not proven, and are documented as best-effort.
- False positives (clean content blocked) — report those as ordinary issues.
- Attacks that require code execution on the proxy host already.

## Supported versions

The most recent release on npm and the programs currently deployed at the ids above.

## Known limitations

Blindseal proves that a specific call was screened under a committed policy by a specific detector version,
and that the committed L1 rules passed. L0 decoding is run by the proxy but is not inside the proof yet; the
model-based layers are attested, not proven: embeddings run locally, and the AI judge is off unless you turn it on
(a TEE mode is planned). Blindseal does not prove
an agent is safe, and does not cover traffic that doesn't pass through the proxy. Details:
`packages/SECURITY_MODEL.md` and `packages/LIMITATIONS.md`.

## Dependency advisories

CI runs `node scripts/audit-deps.mjs` (job `dependency audit`) on every push and pull request. The script runs
`pnpm audit --prod` on the lockfile. It fails on any critical or high advisory that is not listed in
`scripts/audit-allowlist.json`. Each allowlist entry names the GHSA id, the package, why the advisory is not
reachable, and an expiry date. An expired entry also fails the job until the advisory is triaged again.
Moderate and low advisories are printed in the job log but do not fail it.

### Fixed in 0.7.0 (production dependencies)

The 0.6.0 lockfile had 5 critical, 28 high, 31 moderate and 4 low advisories. After 0.7.0 it has no critical
or high advisories.

| Package | Advisories | Fix |
|---|---|---|
| `next` (site) | 4 critical, 11 high and more (e.g. GHSA-f82v-jwr5-mffw, GHSA-2464-fhr4-w9xw, GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) | 14.2.15 → 15.5.28. The 14.x line stops at 14.2.35, which is still affected by the critical ones, so 15.5.28 is the smallest version that fixes them. |
| `postcss`, `nanoid`, `source-map-js` (bundled with `next`) | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-68fv-2mgg-jv7q and more | `next` pins postcss 8.4.31, so the root `pnpm.overrides` sets `next>postcss` to ^8.5.32. This only affects the build. |
| `bigint-buffer` (via `@solana/web3.js`) | GHSA-3gc7-fjrx-p6mg (no patched release) | `@solana/web3.js` 1.98.0 → 1.98.4, which no longer depends on bigint-buffer (it uses `@solana/codecs-numbers` instead). |
| `protobufjs` (via `@xenova/transformers` > `onnxruntime-web` > `onnx-proto`) | GHSA-xq3m-2v4x-88gg (critical) and 10 more | The override `onnx-proto>protobufjs` → ^7.6.3 removes the vulnerable package from the install tree. That is all it does, though: `onnxruntime-web` 1.14 ships with onnx-proto already bundled into its `dist`, so at runtime the `protobufjs` package is never loaded. The actual protection is that the code path cannot be reached (see below). |
| `sharp` (via `@xenova/transformers`) | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w | Override `@xenova/transformers>sharp` → ^0.35.5. |
| `form-data` (via `@anthropic-ai/sdk` > `@types/node-fetch`) | GHSA-hmw2-7cc7-3qxx | Override `@types/node-fetch>form-data` → ^4.0.6. |
| `@remix-run/router`, `react-router` (dashboard) | GHSA-2w69-qvjg-hvjx, GHSA-9jcx-v3wj-wh4m, GHSA-2j2x-hqr9-3h42 | `react-router-dom` 6.28.0 → 6.30.6. |
| `playwright` (optional peer of `next`, test tooling) | GHSA-7mvr-c777-76hp | `playwright` / `@playwright/test` 1.48.2 → 1.55.1. |

**The overrides do not reach npm users.** `pnpm.overrides` only applies to this repository's lockfile. Someone
who installs the published `blindseal` package from npm gets whatever `@xenova/transformers@2.17` resolves to
on their machine: `sharp@^0.32` and `onnx-proto` with `protobufjs@6`. Neither code path is reachable from
Blindseal:
- **sharp** is used only by transformers.js image processing (`RawImage`). Blindseal only calls the
  text `feature-extraction` pipeline (`packages/proxy/src/detection/layer2-embeddings.ts`), so sharp is
  loaded but never decodes an image.
- **protobufjs** is used by `onnxruntime-web` to parse ONNX models in the browser backends. In Node,
  transformers.js runs sessions on `onnxruntime-node`, which parses the model natively. The only model loaded
  is the pinned `Xenova/bge-small-en-v1.5` from Hugging Face, and that download is already a trust boundary
  (`packages/SECURITY_MODEL.md`, "The L2 inputs are trusted").

### Not reachable, allowlisted (moderate)

These are in `scripts/audit-allowlist.json` and expire on 2027-04-30.

| Package | Advisory | Why it is not reachable |
|---|---|---|
| `uuid@8` (via `@solana/web3.js` > `jayson`) | GHSA-w5hq-g745-h8pq | The bug is in `v3()`/`v5()`/`v6()` when the caller passes an output buffer. jayson only calls `v4()`, and never with a buffer. |
| `stream-json@1` (via `@solana/web3.js` > `jayson`) | GHSA-528h-pc64-c93x, GHSA-hqr4-qq8f-hg3x, GHSA-mjw6-4jj6-33hc | web3.js loads only `jayson/lib/client/browser`, which never requires stream-json. Only jayson's `lib/utils.js` requires stream-json, through its servers and the `jayson` package entry, and nothing in this tree loads either one. RPC responses are parsed with `JSON.parse`. |
| `react-router@6` (dashboard) | GHSA-wrjc-x8rr-h8h6 | Fixed only in v7. It is an open redirect through attacker-supplied paths passed to `<Link>`/`navigate()`. Every navigation target in the dashboard is a constant prefix plus a route id or an audit-log id, so no attacker-supplied path is ever navigated to. The dashboard is a `HashRouter` app served on localhost. |
| `react-router@6` (dashboard) | GHSA-337j-9hxr-rhxg | Fixed only in v7. It affects only Framework/Data Mode apps that do SSR hydration (`deserializeErrors`). The dashboard uses Declarative Mode (`HashRouter`), with no SSR and no `hydrationData`. |
