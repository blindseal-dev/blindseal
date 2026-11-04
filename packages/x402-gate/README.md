# @blindseal/x402-gate

Facilitator-side middleware for [x402](https://github.com/coinbase/x402): a payment at or above a
per-mint threshold must carry a Blindseal attestation for exactly that payment. Private workspace
package (not published).

```ts
import { createGate, nodeHttpGate, connectionReader } from '@blindseal/x402-gate';

const gate = createGate({
  chain: connectionReader(connection),           // injected: tests pass a fake
  thresholds: { [USDC]: '50000000', native: 1_000_000_000n },  // >= 50 USDC, >= 1 SOL need an attestation
  unlistedMints: 'allow',                        // or 'require'
});

// framework-agnostic
const decision = await gate({ headers: req.headers, body: parsedJsonBody });
if (!decision.allow) respond(decision.status, { error: decision.code, reason: decision.reason, field: decision.field });

// node:http
http.createServer(nodeHttpGate(gate, (req, res, decision, body) => facilitatorVerify(req, res, body)));
// fetch-style (Workers, Hono, Bun…)
export default { fetch: fetchGate(gate, (request, decision, body) => facilitatorVerify(request, body)) };
```

The attestation travels in `X-Blindseal-Attestation` as base64 of `attestation.json` (the file
`blindseal attest` writes).

## What is decided

1. The payment is read from the request (`extractPayment`, default `x402Payment`): an explicit
   `body.payment = { payer, recipient, mint, amount }`, or the x402 `exact` scheme on Solana —
   `paymentRequirements` (or v2's `paymentPayload.accepted`) gives `payTo` and `asset`, and the client's
   partially signed transaction in `paymentPayload.payload.transaction` is decoded to find the single
   spl-token / token-2022 `TransferChecked` (or `Transfer`) to the ATA of `payTo` for `asset`; its
   authority is the payer and its amount the payment. A System transfer to `payTo` is read the same way
   for native SOL. No readable payment, two matching transfers, an amount under `maxAmountRequired`, or
   a transaction that needs address lookup tables: refused (400, `no_payment`). A gate that fails open on
   an unreadable payment is not a gate.
2. Below the threshold for the mint (or an unlisted mint with `unlistedMints: 'allow'`): allowed,
   `gated: false`, the header is not even read.
3. At or above: the header is required (402, `missing_attestation`), then
   `@blindseal/attestation-check` runs — proof and action binding, the attestation's `sourceAuthority` /
   `recipient` / `mint` / `amount` equal the payment's (403, `action_mismatch`, `field` names the first
   difference), not expired (403, `expired`), nullifier not consumed on chain (403, `consumed`), a bad
   proof (403, `invalid_proof`), a header that is not an attestation (400, `malformed`). A chain that
   cannot be read refuses (403, `chain_unavailable`). With `consumer: { targetProgram, instruction }` the
   attestation must also name that gated program.

The decision carries the payment, the attestation and its nullifier so the facilitator can log them.
`requireAllowed(gate, req)` throws `GateRefusedError` instead of returning a refusal.

What this is not: it does not consume the attestation (only the gated program on chain does, when the
payment lands), so a facilitator that settles must still rely on the chain for replay protection, and
it does not verify the x402 payment itself (signature, balance, simulation) — that is the facilitator's
job after the gate.

Tests: `pnpm test` (vitest; the 0.7.0 mainnet demo attestation, whose nullifier IS consumed on mainnet —
the fake `ChainReader` decides here; synthetic exact-scheme transactions for the extractor; both adapters).
