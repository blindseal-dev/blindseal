# Design: a permissionless prover network

Status: proposal. Nothing in this document is implemented except where it says so. It describes how
third parties could run Blindseal provers for other people's payloads, how they would be paid, and how
they would be held to account. The hosted prover service under construction (`services/prover-host`)
is the single-operator precursor; section 11 says what carries over.

## 1. The caveat first: a remote prover sees the payload

A Blindseal proof hides the payload from everyone who sees the attestation and from the chain. It does
not hide the payload from the machine that produces the proof. The SP1 guest reads the payload as a
private input; whoever runs the prover holds the tool call in clear while proving, and could keep it.

So:

- Local proving stays the default. `blindseal attest` runs the prover on the operator's machine
  (`crates/prover`, CPU client only) and nothing leaves it.
- A remote prover, hosted or networked, is for payloads the user would send to a third party anyway:
  a tool call whose arguments are already public (a transfer to a known address), or one the user is
  content to disclose to the prover under the prover's terms.
- The mitigation path is a prover running inside a TEE whose attestation document the client checks
  before sending the payload. That reduces the set of people who can read the payload to those who
  can break the enclave; it does not make the payload private in the sense the proof does. The
  project's documentation already labels anything that rests on a TEE as attested, not proven; the
  same word applies here.

Nothing below weakens this. A network of provers is a network of parties who see payloads.

## 2. Why a network at all

A single-action proof takes about 2 h 17 m on the reference CPU machine (`docs/performance.md`). Most
operators will not wait that long and many do not have 32 GB of RAM and a Docker daemon with 24 GB
for the Groth16 wrap. A GPU prover brings the same proof down to minutes. Few operators own one. A
market of provers lets operators who accept the caveat buy proving by the proof, and lets anyone with
hardware sell it, without the project running the hardware.

## 3. Roles

| Role | Does | Holds |
|---|---|---|
| Client | Has a screened tool call and an action to bind. Pays per proof. | The payload, the action fields, the result. |
| Prover | Runs the SP1 guest and the Groth16 wrap. Returns an attestation plus a signed receipt. | An operator key, a USDC stake, hardware. |
| Registry program | Records provers, stakes, counters; pays out per epoch; slashes on evidence. | USDC treasury accounts (stake, fee pool). |
| Consumer program | The gated program that CPIs `verify_and_consume`. Unchanged. | Nothing new. |
| Indexer | Reads `Consumed` events and receipts, attributes proofs to provers, submits attribution. | Nothing privileged: anyone can run one. |

## 4. The registry program

A new Anchor program, `blindseal-prover-registry`, separate from `blindseal-verify` so the verifier's
upgrade surface stays small. It uses the same pseudonymous security contact and the same
`security.txt` pattern.

```
RegistryConfig  [b"registry"]
  authority            Pubkey        parameter changes only; cannot touch stakes or the pool
  usdc_mint            Pubkey
  min_stake            u64           USDC base units
  unbond_slots         u64           delay between unstake request and withdrawal
  epoch_slots          u64           e.g. 216,000 (about one day)
  protocol_fee         u64           USDC base units paid into the pool per attributed receipt
  epoch_cap_bps        u16           max share of one epoch's pool a single prover can take
  paused               bool

Prover          [b"prover", operator]
  operator             Pubkey        signs receipts and registry transactions
  endpoint_hash        [u8; 32]      sha256 of the service URL; the URL itself is served off chain
  tee_quote_hash       [u8; 32]      zero if none; see section 9
  stake                u64
  unbond_requested_at  u64           0 if not unbonding
  status               u8            active | unbonding | slashed
  jobs_accepted        u64
  receipts_attributed  u64
  invalid_proofs       u32
  missed_deadlines     u32
  registered_at        u64

Epoch           [b"epoch", u64le(epoch_index)]
  pool                 u64           USDC collected during the epoch
  receipts             u64           total attributed receipts
  closed               bool

EpochShare      [b"share", u64le(epoch_index), operator]
  receipts             u64
  paid                 bool
```

Instructions: `register(endpoint_hash, stake)`, `top_up(amount)`, `request_unbond`, `withdraw`,
`attribute(receipt)`, `slash_invalid_proof(...)`, `claim_timeout(...)`, `close_epoch(epoch)`,
`claim_share(epoch)`. Section 6 to 8 define the ones with checks.

## 5. Staking in USDC

Provers stake USDC: a transfer from the operator's token account into a stake treasury PDA owned by the
registry. `min_stake` is a parameter; a figure that makes one slash meaningful relative to one proof's
price is the right order (a few hundred USDC for a network where a proof costs a few USDC).

Why USDC and not a token of the project's own: the project has no token and does not plan one. A new
token would add a price to defend, a distribution to justify and a regulatory question to answer,
none of which serve the only purpose staking has here, which is to make lying about a proof cost more
than it earns. A stablecoin already on the same chain does that with no further design. Payment,
stake, fees and emissions are all in one unit, so a prover can read its own economics without a
conversion.

Unbonding takes `unbond_slots` (a week is the conventional order) so a prover cannot sign a bad
receipt and withdraw before the evidence lands.

## 6. Receipts and attribution

Every attestation a networked prover returns carries a receipt:

```
attestation.json gains
  "prover": {
    "id":        <base58 operator key>,
    "jobId":     <0x + 64 hex, chosen by the client>,
    "signature": <0x + 128 hex, ed25519>
  }

signed message = sha256("blindseal.receipt.v1" || public_inputs_blob || job_id || operator_pubkey)
```

`public_inputs_blob` is the committed 168-byte blob
(`payloadHash ‖ policyRoot ‖ detectorVersion ‖ actionHash ‖ nullifier ‖ u64le expirySlot`). The
signature binds the prover to exactly those public values; it says nothing about the payload, and
the receipt does not reveal it. The SDK's `verifyOffchain` checks the signature when the `prover`
field is present and reports the prover id alongside the decoded inputs.

The unit of payment is an attributed receipt: a receipt whose nullifier has been consumed on chain.
A proof that was produced but never used earns nothing. This rules out a prover paying itself for
proofs nobody wanted, since every attributed receipt costs a real gated transaction (section 8).

Attribution is a registry instruction, `attribute(nullifier, job_id, signature, public_inputs)`,
callable by anyone. It checks:

1. The `Nullifier` PDA `[b"nullifier", nullifier]` exists under `blindseal-verify` and its
   `action_hash` equals the one in `public_inputs` (so the receipt is for the proof that was
   consumed, not a lookalike).
2. `nullifier == sha256("blindseal.nullifier.v1" ‖ action_hash)` as in the verifier.
3. The ed25519 signature over the receipt message verifies for `Prover.operator` (via the ed25519
   program and the instructions sysvar, the standard pattern).
4. No `Attribution [b"attr", nullifier]` PDA exists yet; create it so one proof pays once.
5. Increment `Prover.receipts_attributed` and the current `Epoch.receipts`; create or update
   `EpochShare`.

Two paths get receipts attributed. A consumer program that wants to may CPI `attribute` right after
`verify_and_consume` in the same transaction. Otherwise an indexer reads `Consumed` events, matches
them against receipts the client published (or the prover published; both have an interest), and
submits `attribute`. Nothing in the verifier changes.

## 7. Slashing

Two offences, both checkable on chain from evidence anyone may submit.

### Invalid proof

A prover signed a receipt over a blob whose proof does not verify, or verifies under a vkey the
verifier does not allow. Evidence: the attestation as returned (proof, blob, receipt).

`slash_invalid_proof(proof, public_inputs, job_id, signature, operator)`:

1. Signature verifies for `operator` over the receipt message (so an attacker cannot forge evidence
   against an honest prover; the prover signed this exact blob).
2. `detectorVersion` from the blob is in `blindseal-verify`'s `Config.allowed_vkeys`; if it is not,
   that is itself the offence and step 3 is skipped.
3. `sp1_solana::verify_proof(proof, public_inputs, vkey, GROTH16_VK_5_0_0_BYTES)` fails. This costs
   about 227k CU, the measured bare-verify figure; the submitter pays it.
4. No `Slash [b"slash", sha256(signature)]` PDA exists; create it.
5. Move `slash_invalid_amount` (a parameter, e.g. the whole stake) from the prover's stake to the
   epoch pool, with a fixed bounty to the submitter; set `status = slashed`; increment
   `invalid_proofs`.

A prover that returns an honest failure ("the payload did not pass L1, no proof") signs nothing and
cannot be slashed for it. Only a signed receipt is evidence.

### Missed deadline

Deadlines are only enforceable for jobs that touch the chain. The network offers two job modes:

- Direct (default): the client pays the prover over the wire (x402 per proof) and no job state exists
  on chain. There is no deadline slashing in this mode; the client's remedy is to stop using the
  prover, and the counters in the registry show who delivers.
- Escrowed: for clients that want a guarantee. `open_job(job_id, price, deadline_slot, prover)`
  moves `price` USDC into a job escrow; the prover `accept_job(job_id)` (its signature is the
  acceptance); `deliver(job_id, receipt)` before the deadline releases the price to the prover and
  the protocol fee to the pool; after the deadline anyone may call `claim_timeout(job_id)`, which
  refunds the client, moves `slash_timeout_amount` from the prover's stake to the client, and
  increments `missed_deadlines`. The job's payload still travels off chain; the chain sees only the
  job id and the commitment to the blob.

Delivery in escrowed mode is checked by the same receipt verification as attribution, plus the proof
verifying (another 227k CU, paid by the prover, who is the one delivering).

## 8. Epoch emissions

Each attributed receipt pays `protocol_fee` into the current epoch's pool (in direct mode the
client's x402 payment includes it and the prover forwards it when the receipt is attributed; in
escrowed mode the escrow splits it). When an epoch ends, anyone may `close_epoch`; then each prover
claims:

```
share_i   = pool × receipts_i / receipts_total
cap       = pool × epoch_cap_bps / 10_000
payout_i  = min(share_i, cap)
```

Unclaimed and capped remainder rolls into the next epoch's pool. Slashed stake also flows into the
pool, so the people who proved honestly during an epoch with a slash share the penalty.

### Why fake jobs do not pay

A prover that wants to inflate its share must manufacture attributed receipts. Each one requires:

- a real proof (the nullifier must be consumed, and `verify_and_consume` verifies the proof), so real
  GPU minutes or CPU hours per receipt;
- a real gated transaction on mainnet: the consumer program's CPI, about 259k CU, the Nullifier PDA's
  rent (about 1.06 M lamports at 5,080 lamports per byte for the 81-byte record plus the 128-byte
  account overhead) and the signature fee;
- the protocol fee `protocol_fee` into the pool, since attribution is what pays it.

With a uniform fee per receipt the pool is `protocol_fee × receipts_total`, so the uncapped share of a
prover with `k` fake receipts and `n` honest receipts from others is
`protocol_fee × (k + n) × k / (k + n) = protocol_fee × k`: exactly what it paid in, before the
transaction costs and the hardware. The cap makes it strictly less once `k` is large. Sybil
registrations do not help: splitting `k` across identities does not change the total, and each
identity needs its own `min_stake`. The fee is what makes the scheme sybil-resistant; the cap is what
stops one honest but large prover from taking the whole pool in a thin epoch.

## 9. The TEE path

A prover may register a `tee_quote_hash`: the hash of an attestation document from a TEE in which the
prover runs. A client that wants it asks the prover for the document, checks it against the registered
hash and against the vendor's root of trust, checks that the measured image is a published build of
the prover service, and only then sends the payload.

This is the mitigation for section 1, and it is only that. The chain never checks the document;
`verify_and_consume` cannot tell a TEE proof from a laptop proof, and the attestation does not claim
one. The registry stores the hash so clients can filter, and so a change of image is visible.

## 10. Operational notes

- GPU proving: the SP1 toolchain supports GPU proving; the project has measured only CPU proving
  (2 h 17 m for the sample attestation, 8,250,797 ms in the fixture). Published figures for GPU
  proving of guests this size are in the minutes; that has not been measured here. The network's
  first job is to publish measured GPU numbers for this guest in `docs/performance.md`, where
  estimates are not allowed.
- The Groth16 wrap needs the 5.0.0 circuit artifacts (about 3 GB) and a container with at least 24 GB
  of memory on the reference machine. A prover is a machine with those, plus the GPU.
- A prover must run the exact guest ELF for the vkey the verifier allows (`CURRENT_VKEY` in the SDK);
  a proof from any other build is a `DisallowedVkey` on chain and, if signed, slashable.
- Pricing per proof is set by each prover and advertised at its endpoint. The hosted service bills per
  proof with x402; the protocol fee is a fixed add-on.
- Payload handling at the prover: the payload is needed only for the duration of the proof. The
  reference service deletes it after writing the attestation and says so in its terms; nothing
  enforces that except the TEE path.
- Session proofs (`session-proofs.md`), if built, give a prover a whole call set at once. That is more
  exposure per job, not a new kind.

## 11. The hosted service as precursor

`services/prover-host` is one prover run by the project: an HTTP service that takes a payload and
action fields, runs `crates/prover`, and returns `attestation.json`, billing per proof with x402. In
network terms it is a registry with one entry and no staking, slashing or emissions. What is built so
that it carries over:

- The receipt format of section 6 (`prover` field, `blindseal.receipt.v1` message), signed by the
  service's operator key from the first version. Clients get attribution for free later.
- Per-proof payment as the unit, which is what attributed receipts are.
- The caveat of section 1 in the service's documentation and in the CLI (`blindseal attest --remote
  <url>` prints it and requires `--i-accept-remote-prover-sees-payload` or an equivalent one-time
  config).
- A measured GPU figure for the production guest.

The rest (the registry program, escrow, epochs) only makes sense once there is more than one
operator, and should not be built before that.

## 12. Threat model

| Threat | Who | Defence | Residual |
|---|---|---|---|
| Prover reads or keeps the payload | any prover | Local proving default; the caveat everywhere; TEE path for filtering | Full: a remote prover sees the payload by construction |
| Prover returns a proof that does not verify | prover | `verify_and_consume` rejects it; `slash_invalid_proof` on the signed receipt | Client lost the fee until the slash bounty; use escrow for guarantees |
| Prover proves for the wrong action | prover | The guest's action binding; the gate recomputes `actionHash`; a mismatched proof is useless and, if signed, slashable as invalid for that blob | None beyond a wasted fee |
| Prover never delivers | prover | Counters; escrowed mode with `claim_timeout` | Direct mode: no on-chain remedy |
| Self-dealing for emissions | prover | Receipts count only when consumed on chain; uniform fee ≥ share; cap | Pool dilution bounded by the cap |
| Sybil registrations | prover | `min_stake` per identity; fee argument is per receipt, not per identity | None beyond stake lock-up |
| Forged slash evidence | third party | Evidence must carry the prover's signature over the exact blob | None |
| Registry authority abuse | project | Authority sets parameters only; cannot move stake or pool; parameter changes announced | Trust in the authority for parameters; multisig on the roadmap as for the verifier |
| Client sends a payload to a prover it should not have | client | Caveat in CLI and docs; opt-in flag | Full: this is a user decision |
| Front-running a gated transaction with a copied proof | anyone | `verify_and_consume` is CPI-only from the target program; a copied proof cannot be consumed elsewhere | None |

## 13. Open questions

1. Who forwards the protocol fee in direct mode, and what happens if a prover takes x402 payment and
   never attributes? (The client can attribute and pay the fee itself to deny the prover the share;
   is that enough?)
2. Should off-chain-only proofs (verified with the wasm verifier, never consumed) ever count? They
   cannot be attributed without a chain record, which argues no.
3. `protocol_fee` as a fixed amount versus a percentage of price; the sybil argument in section 8
   needs it uniform per receipt.
4. Whether the registry should refuse `tee_quote_hash` values it cannot recognise, or store anything
   and leave recognition to clients.
5. Governance of `min_stake` and `epoch_cap_bps` once there are provers with stakes at risk.
6. Whether `attribute` should be callable by the consumer program only, or by anyone (the draft says
   anyone, since the receipt and the nullifier record make the claim self-evident).
