# @blindseal/attestation-check

The one check a consumer runs on a Blindseal attestation before it acts. Shared by
`@blindseal/x402-gate` and `@blindseal/agent-kit-plugin`; private workspace package (not published).

```ts
import { checkAttestation, connectionReader } from '@blindseal/attestation-check';

const result = await checkAttestation(headerValue /* base64 attestation.json, JSON text or object */, {
  sourceAuthority: payer,      // base58: who the transfer debits
  recipient: payee,            // base58: who is paid (for SPL: the destination token account's OWNER)
  mint: usdcMint,              // '' for native SOL
  amount: 1_000_000n,          // atomic units
  // optional: targetProgram + instruction when you know the gated program that will consume it
}, connectionReader(connection));

if (!result.ok) refuse(result.code, result.reason, result.field);
```

Order of checks (the first failure is returned):

1. `malformed` — not an attestation (base64/JSON/shape).
2. `invalid_proof` — `blindseal-sdk` `verifyOffchain`: Groth16 against the committed public inputs,
   the six labels equal the committed values, and the action binding (actionHash recomputed from the
   file's action fields and nonce over the committed inputs; nullifier from the committed actionHash).
3. `action_mismatch` — the attestation's action is not exactly the transfer given; `field` names the
   first differing one in the order chainId, targetProgram, instruction, sourceAuthority, recipient,
   mint, amount.
4. `expired` — committed `expirySlot` is behind the chain's current slot.
5. `consumed` — the Nullifier PDA (`["nullifier", nullifier]` under the verifier program) exists and is
   owned by the verifier.
6. `chain_unavailable` — a chain read threw; the check fails closed.

The chain is read through an injected `ChainReader` (`getAccountInfo`, `getSlot`): `connectionReader`
over a web3.js `Connection`, `rpcReader(url)` over plain JSON-RPC with an injectable `fetch`, or a fake
in tests. Nothing here sends a transaction.

What it does not tell you: whether a particular gated program will accept the proof on chain (its
`EXPECTED_POLICY_ROOTS`, the verifier's vkey and policy allowlists and pause switch), or anything about
the agent's intent beyond the screened payload. Tests: `pnpm test` (vitest, the 0.7.0 mainnet demo
attestation with a fake chain).
