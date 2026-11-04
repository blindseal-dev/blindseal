# Blindseal prover host

A hosted prover: an HTTP service that screens a tool call with Blindseal's proven layers, proves it
(SP1 → Groth16) on a configured backend, and bills one USDC payment per proof over x402. It exists for
integrators who want a Blindseal attestation but have no GPU: a CPU proof takes about 2.5 hours, a GPU
proof minutes.

**The host sees the payload.** The tool call you send is the thing it screens and proves, in clear text.
Use it only for calls you would send to a third party anyway. Local proving (`blindseal attest`) is the
default and the private option; this service is the alternative for people who cannot run the prover.

What you get back is the same `attestation.json` the local prover writes — verifiable with
`blindseal verify`, in the browser verifier, and consumable by a gated program on Solana.

## Run

```
pnpm -C services/prover-host start -- --config prover-host.json
```

`prover-host.json` (every field is checked at startup; problems are listed by field):

```json
{
  "host": "127.0.0.1",
  "port": 8402,
  "publicUrl": "https://prover.example.com",
  "dataDir": "/var/lib/blindseal-prover-host",
  "backend": "local",
  "proverPath": "/opt/blindseal/blindseal-prover",
  "concurrency": 1,
  "priceUsdc": "0.50",
  "payTo": "<your Solana address>",
  "facilitatorUrl": "https://facilitator.payai.network",
  "paymentNetwork": "solana",
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "vast": { "apiKeyFile": "", "gpu": "", "maxPriceUsdPerHour": 1, "maxInstanceAgeMinutes": 60, "image": "" },
  "network": { "enabled": false }
}
```

| field | meaning |
| --- | --- |
| `host`, `port` | where to listen (default 127.0.0.1:8402). Put your own TLS, auth and rate limits in front. |
| `publicUrl` | the URL clients use; named as the paid resource in the 402. Default `http://host:port`. |
| `dataDir` | job records, payloads of unfinished jobs, finished attestations. Created 0700, files 0600. |
| `backend` | `local` (this machine), `vast` or `network` (both implemented on another branch; selecting one here fails with `BackendNotConfigured` until it lands). |
| `proverPath` | the prover binary for `local`. Without it the binary is resolved as `blindseal attest` does: `$BLINDSEAL_PROVER`, `~/.blindseal/bin`, a source checkout, the pinned release download. |
| `concurrency` | proofs run at once (default 1). |
| `priceUsdc` | price of one proof, decimal string, up to six decimals. `"0"` turns billing off. |
| `payTo` | the Solana address that receives the USDC (required when the price is not 0). |
| `facilitatorUrl` | the x402 facilitator that verifies and settles (default PayAI's public endpoint). |
| `paymentNetwork` | `solana` (mainnet) or `solana-devnet`. |
| `rpcUrl` | JSON-RPC used when a job gives neither `expirySlot` nor `noExpiry` (current slot + 40 000, the CLI's window). `$BLINDSEAL_RPC_URL` overrides it. |
| `vast`, `network` | reserved for the other backends. `network` is the network-backend section, so the payment network is `paymentNetwork`, not `network`. |

The path may also come from `$BLINDSEAL_PROVER_HOST_CONFIG`. With the PayAI facilitator,
`PAYAI_API_KEY_ID` / `PAYAI_API_KEY_SECRET` in the environment add their JWT to every facilitator call
(optional: ordinary exact payments work within the free allowance without them).

## API

| method | path | |
| --- | --- | --- |
| `POST` | `/jobs` | screen, charge, queue. `202` with the job record, `402` when payment is missing or rejected, `422` when the payload is refused. |
| `GET` | `/jobs/:id` | the record: `status` queued / running / done / failed, `payment`, `error`. |
| `GET` | `/jobs/:id/attestation` | the attestation once `done` (`409` before, `404` unknown). |
| `GET` | `/healthz` | backend, queue depth, and what a proof costs. |

`POST /jobs` takes the inputs the prover CLI takes:

```json
{
  "call": { "tool": "transfer_sol", "args": { "to": "…", "lamports": 1000000, "from": "…" } },
  "targetProgram": "9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa",
  "instruction": "0x981894646560fc2b",
  "expirySlot": 463600736,
  "decisionId": "d_…",
  "nonce": "0x…"
}
```

- `call` is `{ tool, args }` (`toolName` is accepted too, as in the CLI's input file); the payload is
  `JSON.stringify({ tool, args })`, exactly as `blindseal attest` serializes it. Or send `payload`: the
  exact payload bytes, base64 — those bytes are what is hashed and proved.
- `targetProgram` and `instruction` are optional: the payload decides them (`args.program`, else the
  transfer-gate; `args.instruction` / `args.method`, else `gated_transfer`). A value that disagrees with
  the payload is refused, as the guest would refuse it.
- `expirySlot` or `noExpiry: true`; without either the host fetches the current slot and adds 40 000.
- `decisionId` and `nonce` are optional; a decision id is drawn when absent.

The order inside `POST /jobs` is fixed: parse (400) → the payload/action binding and the proven layers
L0 → L1 (422) → the expiry slot (400 / 503) → payment (402) → queue (202). A payload the guest would
refuse is refused before any payment is looked at, so it costs nothing — and the refusal says why
(`code`, `verdict`, `patterns`).

The job record carries no payload. `GET /jobs/:id` after a failed proof shows `error` and, when the
proof was paid for, `payment.status: "charged-failed"` (see Billing).

## Billing

Per proof, in USDC, over [x402](https://x402.org): an unpaid `POST /jobs` answers `402 Payment Required`
with the requirements in the `PAYMENT-REQUIRED` header (x402 v2, base64 JSON; repeated in the body for
people): scheme `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, the USDC mint, `amount` in
atomic units (`priceUsdc` × 10⁶), `payTo`, and the facilitator's `feePayer`. The client signs a USDC
transfer and retries with it in `PAYMENT-SIGNATURE`. The host asks the facilitator to **verify**, then
to **settle**, then queues the job — all inside that one request.

Settle-before, not settle-after: a Solana `exact` payment is a partially signed transaction whose
blockhash expires in about a minute, so it cannot wait for a proof that takes minutes or hours. The
consequences, stated plainly:

- a payload the guest would refuse, a bad payment, or a settlement the facilitator cannot complete:
  nothing is charged and no job exists;
- a proof that fails after settlement: the job is `failed` and `payment.status` is `charged-failed`,
  with the payer address and the settlement transaction recorded. Nothing in this service can move funds
  back; the operator refunds by hand from the record.

`priceUsdc: "0"` disables billing entirely: no facilitator is contacted, `payment.status` is
`not-billed`, and anyone who can reach the port can queue a proof — put your own authentication in front.

### The SDK, and the alternative

The owner named two SDKs: PayAI's and Corbits'.

- **Chosen: `@x402/core` 2.29.0 with `@payai/facilitator` 2.4.6.** `@x402/core` is the x402 v2 reference
  resource server (Apache-2.0, published 2026-10-28, one dependency: zod); `@payai/facilitator` is PayAI's
  thin config for it (the facilitator URL plus optional JWT auth) — that is what PayAI's docs call its
  server SDK. The facilitator does the Solana work (it checks the transfer and signs as fee payer), so
  the server never touches a Solana RPC. The facilitator URL is a constructor argument, which is what
  lets the tests run against an in-process facilitator that answers `/supported`, `/verify`, `/settle`.
  The reference Solana scheme package (`@x402/svm`) would add `@solana/kit` 8 and the `@solana-program/*`
  clients for what the server side amounts to — a six-decimal price conversion and copying `feePayer`
  from `/supported` — so `src/billing/x402.ts` implements that `SchemeNetworkServer` in a few lines.
- **Alternative: Corbits' Faremeter (`@faremeter/middleware`, `@faremeter/payment-solana`, 0.22.0).**
  Also x402 (v1 and v2), Solana-first, with Express and Hono adapters and its own facilitator. Not
  chosen because the packages were last published 2026-05-27, are LGPL-3.0 in an MIT repository, and
  `@faremeter/payment-solana` brings arktype, hono and the `@solana/*` 6.x tree as runtime dependencies.
  Swapping would mean replacing `src/billing/x402.ts` only; the rest of the service does not know
  which SDK bills.

## Jobs, storage, privacy

- In-memory FIFO, `concurrency` at a time. Each job runs in its own `mkdtemp` directory (0700) holding
  the payload (0600) and the prover's `attestation.json`; the directory is removed when the job ends,
  however it ends.
- `dataDir/jobs/<id>.json` is the record; `dataDir/attestations/<id>.json` the result; and
  `dataDir/payloads/<id>.json` the payload **while the job is unfinished**, deleted the moment it is
  done or failed. That copy is what lets a restart resume paid jobs: on start the host re-queues every
  unfinished job that still has its payload and marks the rest `failed` (`error.code: "lost"`).
- `SIGINT` / `SIGTERM` stop the listener, abort running proofs (those jobs return to `queued`) and exit.

## Backends

`src/backends/types.ts` is the contract (`ProofBackend`, `ProofJob`, `AttestationJson`,
`BackendNotConfigured`); it imports nothing else so other backends can be written against it. `local`
spawns the prover with the same argv `blindseal attest` builds. `vast` and `network` are stubs here
and are being implemented on a separate branch; `src/backends/index.ts` is the registry the config
key selects from.

## Why the service imports proxy source

`src/upstream.ts` imports `runLayer0` / `runLayer1`, the payload/action binding and the prover resolver
from `packages/proxy/src` by relative path: the `blindseal` package publishes binaries only, and a copy of
the detectors would have to be kept byte-for-byte in step with the Rust guest (the parity gate in CI
checks the proxy's copy, not a second one). If the proxy ever exports them, that one file changes.

## Tests

```
pnpm -C services/prover-host test
```

No real proof is run: `test/fixtures/fake-prover.sh` stands in for the binary and writes the committed
mainnet sample attestation; an in-process facilitator stands in for PayAI's. Covered: queue order and
concurrency, persistence across a restart, the local backend's argv, the 402 requirements, a rejected
payment, a failed settlement, a paid job through to its attestation, an injected payload (base64 in the
memo) refused with no facilitator call, a backend failure after settlement (`charged-failed`), and
billing off.
