# Design: session proofs

Status: proposal. Nothing in this document is implemented. It describes a change to the guest, the
verifier program, the SDK and the CLI so that one proof can cover a bounded set of tool calls instead
of one. Byte layouts and domain strings follow the conventions of the shipped code
(`crates/detector-core/src/lib.rs`, `programs/blindseal-verify/src/lib.rs`, `packages/sdk/src/ix.ts`).

## 1. Motivation

An attestation today is one proof per action. The guest screens one payload, binds one on-chain
action and commits six public values; the verifier consumes one nullifier. On the reference machine
that proof takes about 2 h 17 m on CPU (`docs/performance.md`). That fits a prove-then-act flow, where
the operator decides in advance which transfer an agent may make and waits for the proof. It does not
fit an interactive agent that makes a dozen tool calls in an afternoon, each of which should be
gated.

Most of the proving cost is fixed per proof, not per payload: recomputing the policy root over the
serialized DFAs, deserialising them, the Groth16 wrap. Screening one more payload is small by
comparison. A session proof amortises the fixed cost over a bounded list of calls: the guest screens
every payload, binds every action, checks a budget over the list, and commits a Merkle root over the
per-call bindings. On chain, the proof is verified once and each call is consumed by a Merkle
membership check instead of a Groth16 verify.

The claim per call is unchanged. A session proof says, for each call in the set: this payload (by
hash) was screened under this policy by this detector version, L0 and L1 passed, and the payload
describes exactly this action. It adds one claim about the set: the actions together stay within a
stated budget and a stated time window.

## 2. Session definition

A session is three things the operator fixes before proving starts.

| Part | Content |
|---|---|
| Budget | For each mint touched by the session, the maximum total `amount` across all calls. The native asset is the all-zero mint, as in `ActionFields`. |
| Window | `windowStart` and `windowEnd`, Solana slots. Every call's `expirySlot` must lie inside it; no call can be consumed after `windowEnd`. |
| Call set | An ordered list of at most 256 tool calls. Each entry is the payload bytes (the `{tool, args}` JSON that `blindseal attest` serialises today) and the parsed action (`ActionFields`: chainId, targetProgram, sourceAuthority, instruction, recipient, mint, amount) plus a per-call `expirySlot`. |

Two restrictions keep the on-chain side simple and are asserted by the guest: every call in a session
has the same `targetProgram` and the same `sourceAuthority`. A session is one agent (authority) talking
to one gated program. Mixed targets are an open question (section 10).

The call set is fixed at proving time. A call not in the set needs a new session or a single-action
attestation, which keeps working.

## 3. Guest changes

The session guest is a separate SP1 program with its own ELF and verifying key. The existing guest is
untouched; the two coexist (section 7).

### Inputs

```
private inputs (read in this order):
  dfas               Vec<Vec<u8>>        serialized L1 DFAs, as today
  detector_version   [u8; 32]            the session guest's own vkey (public input, checked on chain)
  chain_id           u16
  target_program     [u8; 32]
  source_authority   [u8; 32]
  window_start       u64
  window_end         u64
  budget             Vec<(mint [u8;32], max_amount u64)>   sorted by mint, no duplicates
  session_nonce      [u8; 32]            fresh randomness, never reused
  calls              Vec<Call>           at most 256
    Call { payload: Vec<u8>, instruction: [u8;8], recipient: [u8;32], mint: [u8;32],
           amount: u64, expiry_slot: u64 }
```

### Steps

```
policy_root = policy_root_from_serialized(dfas)
assert budget sorted by mint, no duplicate mints, len <= 8
assert window_start <= window_end
assert 1 <= calls.len() <= 256

for (i, call) in calls:
    action = ActionFields { chain_id, target_program, source_authority,
                            call.instruction, call.recipient, call.mint, call.amount }
    check_action_binding(call.payload, action)            -- step 0 of the shipped guest
    text = utf8_lossy(call.payload)
    assert run_layer1_serialized(text, dfas).verdict == Clean
    assert run_layer0_serialized(text, dfas) is None      -- decode-then-L1, as in 0.8.0
    assert window_start <= call.expiry_slot <= window_end
    spent[call.mint] += call.amount                       -- checked add; overflow is a refusal
    payload_hash_i = sha256(call.payload)
    nonce_i        = sha256("blindseal.session.callnonce.v1" || session_nonce || u32le(i))
    action_hash_i  = action_hash(action, Commitments { payload_hash_i, policy_root,
                                 detector_version, call.expiry_slot, nonce_i })
    leaf_i         = sha256("blindseal.session.leaf.v1" || u32le(i) || payload_hash_i || action_hash_i)

for each (mint, spent) in spent:
    assert budget contains mint and spent <= budget[mint]  -- a mint with no budget line is a refusal

session_root     = merkle_sha256(leaf_0 .. leaf_{n-1})     -- pairwise sha256, duplicate the last
                                                           -- leaf when a level is odd, as policy_root does
budget_hash      = sha256("blindseal.session.budget.v1" || u32le(len) || for each: mint || u64le(max))
session_hash     = sha256("blindseal.session.v1" || u16le(chain_id) || target_program || source_authority
                          || policy_root || detector_version || session_root || budget_hash
                          || u64le(window_start) || u64le(window_end) || u32le(n) || session_nonce)
session_nullifier = sha256("blindseal.session.nullifier.v1" || session_hash)
```

`action_hash_i` uses the shipped `blindseal.action.v1` layout unchanged. That is deliberate: the gated
program's recompute (`compute_action_hash` in the verifier) is reused as is, with `nonce_i` passed where
the single-action flow passes its random nonce. A leaf therefore binds exactly what a single-action
attestation binds today, plus its index.

The guest refuses (panics, so no proof exists) on any failed assertion, as the shipped guest does.
The host runs the same checks first, as `crates/prover` runs `check_action_binding` today, so a bad
call fails in milliseconds with its index rather than inside the zkVM.

### Public values

Committed in this order:

```
[0..32)     targetProgram
[32..64)    sourceAuthority
[64..96)    policyRoot
[96..128)   detectorVersion
[128..160)  sessionRoot
[160..192)  budgetHash
[192..224)  sessionNullifier
[224..232)  windowStart   u64 LE
[232..240)  windowEnd     u64 LE
[240..244)  callCount     u32 LE
```

244 bytes. The single-action blob is 168 bytes
(`payloadHash ‖ policyRoot ‖ detectorVersion ‖ actionHash ‖ nullifier ‖ expirySlot`); the two are
told apart by length and, authoritatively, by which vkey they verify under. There is no per-call
`payloadHash`, `actionHash` or `nullifier` in the public values: those live in the leaves and are
revealed one at a time when a call is consumed. The per-call nullifier is derived, not committed:

```
call_nullifier_i = sha256("blindseal.session.call.v1" || session_nullifier || u32le(i))
```

It exists so that each consumed call has a single 32-byte identifier of the same shape as today's
nullifier, for events, indexers and `blindseal submit --check`.

## 4. Verifier changes

Two instructions are added to `blindseal-verify`. `verify_and_consume` is unchanged.

### Accounts

```
SessionConfig  [b"session-config"]
  authority            Pubkey      same authority as Config
  allowed_vkeys        Vec<[u8;32]>  max 8, session guests only
  paused               bool
  bump                 u8

Session        [b"session", session_nullifier]
  target_program       Pubkey
  source_authority     Pubkey
  policy_root          [u8; 32]
  detector_version     [u8; 32]
  session_root         [u8; 32]
  budget_hash          [u8; 32]
  window_start         u64
  window_end           u64
  call_count           u32
  consumed             [u8; 32]    bitmap, bit i = call i consumed
  consumed_count       u32
  created_at_slot      u64
  consumer_program     Pubkey      the program that opened it (the top-level caller)
  bump                 u8
```

A separate `SessionConfig` PDA avoids changing the layout of the live `Config` account (fixed size,
`max_len 8`). The vkey allowlist for session guests is its own list so a single-action vkey can never
be presented as a session vkey or the other way round.

### `verify_session(proof, public_inputs, budget: Vec<BudgetLine>)`

Checks, in order, each with its own error:

1. CPI from exactly one level (`get_stack_height() == 2`), as `verify_and_consume`.
2. The top-level program (instructions sysvar) equals `targetProgram` from the public inputs.
3. `SessionConfig` not paused; `detectorVersion ∈ SessionConfig.allowed_vkeys`.
4. If `Config.allowlist_policies`: `PolicyRoot[policyRoot]` exists (same check as today).
5. `public_inputs.len() == 244`; `windowStart <= windowEnd`; `windowEnd >= Clock::slot`; `1 <= callCount <= 256`.
6. `budgetHash == sha256("blindseal.session.budget.v1" ‖ …)` over the `budget` argument (so the
   budget is stored in clear in the transaction and can be indexed, but only if it matches the proof).
7. `Session[sessionNullifier]` does not exist.
8. Groth16 verify via `sp1_solana::verify_proof(proof, public_inputs, vkey, GROTH16_VK_5_0_0_BYTES)`.
9. Create the `Session` PDA (payer = the CPI's payer), bitmap zero, `consumer_program = caller`; emit
   `SessionOpened { session_nullifier, session_root, budget_hash, window_end, call_count, consumer }`.

The budget is not enforced on chain. The guest already proved that the sum of amounts in the call
set is within it; storing it lets explorers show what the session was allowed to do.

### `consume_from_session(index, payload_hash, expiry_slot, nonce, proof: Vec<[u8;32]>, action: ActionArgs)`

1. CPI from exactly one level; the top-level program equals `action.target_program` and equals
   `Session.target_program`.
2. `SessionConfig` not paused. `Clock::slot <= Session.window_end` and `>= Session.window_start`;
   `expiry_slot >= Clock::slot`; `window_start <= expiry_slot <= window_end`.
3. `index < call_count`; bit `index` of `consumed` is clear, else `CallAlreadyConsumed`.
4. `action.source_authority == Session.source_authority`.
5. Recompute `action_hash = compute_action_hash(action, payload_hash, Session.policy_root,
   Session.detector_version, expiry_slot)` with `action.nonce = nonce`. This is the existing
   function; the fields come from the gated program's own accounts and args, never from the agent.
6. `leaf = sha256("blindseal.session.leaf.v1" ‖ u32le(index) ‖ payload_hash ‖ action_hash)`; walk
   `proof` (sibling hashes, bottom up; the position at each level follows from `index`) to a root; it
   must equal `Session.session_root`, else `NotInSession`. The verifier duplicates the last node on an
   odd level exactly as the guest's `merkle_sha256` does; the SDK builds proofs the same way.
7. Set bit `index`, increment `consumed_count`; compute
   `call_nullifier = sha256("blindseal.session.call.v1" ‖ session_nullifier ‖ u32le(index))`; emit
   `Consumed { nullifier: call_nullifier, action_hash, policy_root, consumer }` (the existing event).

A wrong recipient, amount, mint or instruction surfaces as `NotInSession`: the leaf is a hash over the
whole action, so the program cannot tell which field diverged, exactly as `ActionHashMismatch` cannot
today.

No `Nullifier` PDA is created per call; the bitmap is the consumed state. Whether to also write a
`Nullifier` record (so `decodeNullifier` and the explorer's per-nullifier lookups keep one code path)
is an open question; it costs rent per call, which the bitmap was introduced to avoid.

### Compute units

`docs/performance.md` records only measured numbers; these are estimates from its deltas and will be
replaced by measurements before anything ships.

| Instruction | Estimate | Basis |
|---|---|---|
| `verify_session` | ~260k CU | `verify_and_consume` measured ~254k inside the CPI, of which the bare Groth16 verify is 227,375; the session variant adds two sha256 over short inputs for `budgetHash` and the PDA write of a larger account. |
| `consume_from_session` | 15k–30k CU | No Groth16. One sha256 for `actionHash`, one for the leaf, up to 8 for the Merkle path, one for the per-call nullifier, plus account loads and the bitmap write. The replay on mainnet that failed at the nullifier check cost 8,176 CU in the verifier, which bounds the fixed overhead. |

A gated transaction that consumes from an open session therefore fits under the 200k default and
does not need the `ComputeBudget` instruction the SDK adds today (`VERIFY_CU_LIMIT = 400_000`). The
transaction is also smaller: a 32-byte Merkle path of depth 8 plus the leaf fields replaces the
260-byte proof and the 168-byte blob.

## 5. Gated program changes

A gated program that accepts sessions adds one instruction (or a flag on its existing one) that CPIs
`consume_from_session` instead of `verify_and_consume`, forwarding the same `ActionArgs` it builds
from its own accounts and args today. `transfer-gate` would gain `gated_transfer_from_session(index,
payload_hash, expiry_slot, nonce, merkle_proof, amount)` and keep `gated_transfer`. Its
`EXPECTED_POLICY_ROOTS` check reads `policyRoot` from the `Session` account rather than from the
blob; the SDK exposes `decodeSession` for that.

Opening the session is also the gated program's job (CPI-only rule): `open_session(proof,
public_inputs, budget)` on `transfer-gate` forwards to `verify_session`. A program that does not want
to pay for sessions does not add these instructions and nothing changes for it.

## 6. SDK and CLI changes

SDK (`packages/sdk`):

- `SessionAttestation` type: `version`, `chainId`, `targetProgram`, `sourceAuthority`, `policyRoot`,
  `detectorVersion`, `sessionRoot`, `budgetHash`, `sessionNullifier`, `windowStart`, `windowEnd`,
  `budget[]`, `calls[]` (each: `index`, `payloadHash`, `actionHash`, `expirySlot`, `nonce`, `action`,
  `callNullifier`), `publicInputs: [hex]` (244 bytes) and `proof`. The per-call fields are labels,
  like the action fields of `attestation.json`; `recomputeSessionBinding` recomputes each leaf and
  the root from them and compares to the committed `sessionRoot`.
- `decodeSessionPublicInputs(blob)` for the 244-byte layout; `sessionPda`, `sessionConfigPda`.
- `merkleProof(leaves, index)` and `merkleRoot(leaves)` with the duplicate-last rule.
- `buildVerifySessionIx`, `buildConsumeFromSessionIx`, and for the example gate
  `buildOpenSessionIx`, `buildGatedTransferFromSessionIx`.
- `verifyOffchain` accepts a session attestation: the wasm verifier gets the 244-byte blob and the
  session vkey; the per-call recompute runs in TypeScript.

CLI (`packages/proxy`):

- `blindseal attest --session calls.json --budget <mint>=<max> ... --window <slots>` writes
  `session.json`; a call that would fail in the guest is refused before proving with its index.
- `blindseal verify session.json` (off-chain), `blindseal submit session.json --open` (open the
  session through the gate), `blindseal submit session.json --call <index>` (one gated transfer),
  `blindseal submit session.json --check` (read the bitmap and print per-call state).

The prover (`crates/prover`) gains a `--session` mode that reads the call list and writes
`session.json`; the single-action mode is unchanged.

## 7. Migration

- Both guests ship. The single-action guest keeps its vkey; the session guest has a new one. The
  verifier's `Config.allowed_vkeys` is not touched; the new `SessionConfig.allowed_vkeys` lists the
  session vkey only. A single-action proof cannot open a session and a session proof cannot be
  consumed by `verify_and_consume`, because each instruction verifies against its own list and the
  blobs differ in length.
- `verify_and_consume` and the single-action flow stay the default for one-off actions and for
  integrators who have not added session instructions.
- The program upgrade adds instructions and a new PDA type; no existing account changes layout.
  Existing nullifiers and policy roots are unaffected. Release procedure as for 0.7.0
  (`docs/release-0.7.0-mainnet-plan.md`): upgrade, then `initialize_session_config`.
- The site's verify page and the explorer learn the second attestation shape; until then they name
  it as unsupported rather than failing silently.

## 8. Security analysis

### What a session proof does not claim

Everything a single-action attestation does not claim (`packages/SECURITY_MODEL.md`) still holds:
not that the agent is safe, not that L2 or L3 approved anything, not that traffic outside the proxy
was screened. In addition, a session proof does not claim that the agent will make these calls, in
this order, or at all; that the budget bounds anything outside the session; or that the calls are
sensible together. It claims that each listed call passed L0 and L1 and describes its bound action,
and that the listed amounts sum to no more than the budget per mint.

### Replay across sessions

A leaf is bound to its session by the Merkle path to `sessionRoot`, and the `Session` account is keyed
by `sessionNullifier`, which commits `sessionRoot`, the budget, the window and a fresh `sessionNonce`.
Presenting a leaf from session A with session B's account fails the root check. Opening the same
session twice fails because the PDA exists. Two sessions with identical call sets, budgets and windows
differ in `sessionNonce`, so they have different nullifiers and different per-call nonces; the gate
treats them as distinct, as it treats two single-action attestations for identical transfers today.

### Budget double-spend across two sessions

The budget is a property of one session. Two sessions for the same authority and gate, each within
its own budget, can both be open in overlapping windows, and the agent can spend both. This is the
same situation as two single-action attestations today. A gate that wants a per-authority limit
enforces it itself; a cheap way is a `SessionSlot` PDA keyed by `(target_program, source_authority)`
that records the open session's `windowEnd` and refuses `open_session` until it has passed. That is
a gate policy, not a verifier rule, and the design leaves it to the gate.

### Expiry

Every call's `expirySlot` is inside the window and is checked at consume time, as today; the window
end is checked both when the session is opened and at every consume. A session proof is produced
hours before it is used, so windows are set relative to the expected proving time (a 24-hour window
is roughly 216,000 slots at 400 ms). A session whose window has passed cannot be opened; an open
session with unconsumed calls simply stops being usable.

### A call set the agent did not make

The leaves are what the operator listed, not what the agent did. A listed call that is never made is
never consumed and harms nothing. A call the agent makes that is not in the set has no leaf and
cannot be consumed. A leaf cannot be consumed for a different action because the gate recomputes
`actionHash` from the instruction it is about to execute and hashes that into the leaf; the Merkle
path then fails.

### Partial consumption and order

Calls are consumed in any order. Index is an identifier, not a sequence number. A gate that needs
ordering (call 3 only after call 2) can check `consumed` bits itself, since the `Session` account is
readable; the verifier does not enforce it.

### Information revealed

Opening a session reveals the target program, the authority, the policy root, the detector version,
the budget (in clear), the window and the call count. Each consume reveals that call's `payloadHash`,
`expirySlot`, `nonce` and action. Unconsumed calls reveal nothing beyond the count. Payloads are
never revealed, as today.

## 9. Proving cost

Not measured yet. The method is the one `docs/performance.md` uses: `BLINDSEAL_EXECUTE=1` cycle
counts for 1, 8, 64 and 256 calls, then one full proof. The expectation to test is that cycles grow
roughly linearly in total payload bytes from a fixed offset near today's single-call count (about
104 M cycles for the 0.7.0 guest), because the DFA deserialisation and the policy-root Merkle happen
once per proof. L0's nested decoding to depth 3 is the per-call term most likely to dominate.

## 10. Open questions

1. Mixed targets: should a session span several gated programs? It would need a per-call
   `targetProgram` in the leaf and a different CPI rule for `verify_session`.
2. Per-call `Nullifier` records in addition to the bitmap, for one lookup path across both flows.
3. Maximum call count: 256 keeps the bitmap in 32 bytes and the Merkle depth at 8; is it enough?
4. Should `windowStart` be enforced at consume time, or only `windowEnd`? The draft enforces both.
5. Budget by count as well as by amount (at most N calls per mint)?
6. Whether a session attestation should be accepted by the hosted prover service, given that a
   session reveals more payloads to the prover at once (see `prover-network.md`).
7. Closing a fully consumed or expired session to reclaim rent: who may close it, and to whom the
   lamports go.
