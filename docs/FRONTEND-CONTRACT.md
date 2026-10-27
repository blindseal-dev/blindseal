# Frontend data contract (authoritative)

The design mockups (`design/mockups/`) were built before the engine existed, so
their client-side mock backend (`design/mockups/mockups/_shared/fixtures.js`) **guessed** several
shapes. This file is the source of truth. Where a mockup shape disagrees with this file, this file
wins, and the production frontend must follow it.

The production dashboard and site do **not** use `fixtures.js`. They call the proxy's local API
(`packages/proxy/src/api/mock-server.ts` in mock mode, the real engine later) over the
endpoints listed in §6, served from `fixtures/*.json`. `fixtures.js` is reference-only and is discarded in the
production port.

Verified against: `crates/guest/src/main.rs`, `crates/prover/src/main.rs`,
`crates/detector-core/src/lib.rs`, `fixtures/generate.mjs`, `evals/vectors/policy-root.txt`.

---

## 1. Attestation public values — 6 values, fixed order

The SP1 guest commits exactly **six** public values, in this order (`crates/guest/src/main.rs`):

| # | field          | type      | notes |
|---|----------------|-----------|-------|
| 0 | `payloadHash`  | 32 bytes  | `sha256(payload)` |
| 1 | `policyRoot`   | 32 bytes  | Merkle root, see §3 |
| 2 | `detectorVersion` | 32 bytes | the SP1 **vkey** (see §2) — a public *input*, not derived in-guest |
| 3 | `actionHash`   | 32 bytes  | see §4 |
| 4 | `nullifier`    | 32 bytes  | see §4 |
| 5 | `expirySlot`   | u64       | little-endian when hashed; decimal in JSON |

`attestation.json` carries both a raw blob and the decoded fields:

```jsonc
{
  "version": 1,
  "payloadHash":     "0x…",   // 32-byte hex
  "policyRoot":      "0x…",
  "detectorVersion": "0x…",   // the vkey
  "actionHash":      "0x…",
  "nullifier":       "0x…",
  "expirySlot":      280000000,
  "publicInputs":    ["0x…"],  // ONE element: hex of the raw committed blob the verifier checks
  "proof": { "protocol": "groth16", "curve": "bn254", "bytes": "0x…" }, // ~260 bytes (4-byte selector + 256)
  "proveMs": 0
}
```

- **`publicInputs` is a single-element array**: `publicInputs[0]` is the hex of the raw committed
  public-values blob (`proof.public_values.as_slice()`), which is exactly what `sp1-verifier` /
  `sp1-solana` verify the proof against. The six named fields above are the **decoded** view of that
  same blob, in the order in §1. The verify page (S03) and attestation detail (D05) decode
  `publicInputs[0]` into those six fields for display; they verify against the blob, not the fields.
- `fixtures/*.json` (mock API) are mixed: `attestation-sample.json` and `attestations.json[0]` now
  carry the **real 1-element raw blob** (what the prover emits); the remaining list entries keep the
  **decoded** 6-element array for convenience. The dashboard handles both via
  `packages/dashboard/src/api/publicInputs.ts::splitPublicInputs` (decodes the len-1 blob into the six
  named fields; passes a 6-element array through). The production UI must handle the raw blob form.

## 2. `detectorVersion` is the vkey, not a version string

`detectorVersion` is the **SP1 Groth16 verifying key** for the committed guest ELF: `0x` + 64 hex
(32 bytes), e.g. `0x007e7ae6…`. The Solana program checks the attestation's `detectorVersion`
equals the vkey it verified with. It is **not** a semver like `"det-2026.10.1"` and **not**
`sha256(version)`. Display it as a hash component (copy-to-clipboard, `0x1234…abcd`).

> `fixtures.js` guessed `detectorVersion: "det-2026.10.1"` and a separate
> `detectorVersionHash = sha256(detectorVersion)`. Both are wrong. There is one value: the vkey.

## 3. `policyRoot` — not reproducible in the browser

The committed policy root is a Merkle tree over **serialized `regex-automata` DFA bytes**, one leaf
per committed L1 rule, plus one leaf for the zero-width-density threshold parameter. For the default
policy that is **22 rule leaves + 1 threshold leaf = 23 leaves**, giving:

```
0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397
```

(`evals/vectors/policy-root.txt`; detector-core `policy.rs` asserts it; TS and on-chain must match.)

- **The browser cannot recompute this.** The leaves are compiled DFA bytes, not rule JSON. The D04
  policy page's "Save recomputes the Merkle root visibly" must get the new root **from the API**
  (`PUT /policy` → `{ root, version, … }`); it must not compute a root in JS.
- Rule domain: `blindseal.rule.v1`; empty-policy domain: `blindseal.policy.empty.v1`.

> `fixtures.js` guessed 25 rules and an in-browser `sha256(canonical(rule))` Merkle. Both wrong: 22
> rules, DFA-byte leaves, root from the backend.

### 3.1 The 22 committed L1 rules

All layer `L1`, `kind: "dfa"`. `severity` → dashboard verdict: **Malicious → block**, **Suspicious → flag**.
Full list in `fixtures/policy.json` and `crates/detector-core/src/lib.rs` (`RULES`). L0 is
**decode-then-L1** (base64/hex/url/html-entity decoders that re-run L1 on decoded text), surfaced in
decisions as an `L0` layer whose `ruleIds` name the decoder; L0 is not a separate set of policy
leaves.

## 4. Action binding — `actionHash` and `nullifier`

Action fields (`ActionFields`, `crates/detector-core`), **including `sourceAuthority`**:

`chainId: u16` (1 = solana mainnet; 2 reserved — there is no devnet target), `targetProgram: [u8;32]`,
`sourceAuthority: [u8;32]`, `instruction: [u8;8]` (anchor discriminator or `sha256(name)[..8]`),
`recipient: [u8;32]`, `mint: [u8;32]` (zero = native SOL), `amount: u64`.

```
actionHash = sha256( "blindseal.action.v1"
                   ‖ chainId(LE) ‖ targetProgram ‖ sourceAuthority ‖ instruction
                   ‖ recipient ‖ mint ‖ amount(LE)
                   ‖ payloadHash ‖ policyRoot ‖ detectorVersion ‖ expirySlot(LE) ‖ nonce )

nullifier  = sha256( "blindseal.nullifier.v1" ‖ actionHash )
```

> `fixtures.js` guessed `nullifier = sha256("nullifier:" + nonce + actionHash)` and an action
> without `sourceAuthority`. Use the definitions above. The UI never recomputes these; it displays
> them and (D05) decodes them from `publicInputs`.

## 5. S03 /verify — five-step checklist, what is and isn't offline

The verify page runs the real Groth16 verifier compiled to WASM (`crates/verifier-wasm`, confirmed to
build for `wasm32-unknown-unknown`: `sp1-verifier` + `substrate-bn-succinct` compile). Of the checks:

| step | offline? | how |
|------|----------|-----|
| proof verifies against `publicInputs[0]` + vkey | **yes** | WASM `verify_attestation` |
| schema / field well-formedness | yes | parse |
| `detectorVersion` is an allowlisted vkey | needs data | ship a bundled allowlist, or RPC read |
| `policyRoot` is allowlisted on chain | **RPC read** | Solana `getAccountInfo` |
| `nullifier` not yet consumed | **RPC read** | Solana account/PDA read |

"What this does not reveal": the payload, the matched rules, and the agent identity are **not** in
the attestation — only hashes. Keep that panel.

## 6. Where the dashboard gets each thing (mock mode)

`GET /decisions`, `/decisions/:id`, `/policy`, `/attestations`, `/attestations/:id`, `/audit`, the
`/events` WebSocket, etc. — the local API contract, served by `mock-server.ts` from
`fixtures/*.json`. Build the dashboard against this; it is the shape the real engine will also serve.

### Added in M2 — on-chain reads (server-side, same-origin for the UI)

- `GET /api/nullifiers/:nullifier` → `{ nullifier, consumed: bool, pda, consumedAtSlot?, consumerProgram?,
  actionHash?, cluster: "mainnet-beta", rpc: "configured" | "public" }`. The proxy reads mainnet via
  `BLINDSEAL_RPC_URL` (public endpoint when unset — rate-limited and logged; `off` disables). The
  browser never contacts an RPC: zero-egress is preserved by construction.
- The site's `/explorer` is a server component over the same reader (`@blindseal/chain-reads`):
  consumed-nullifier count, registered policy roots, consumer programs, per-day buckets.
