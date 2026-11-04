# @blindseal/agent-kit-plugin

A [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) v2 plugin that puts Blindseal in
front of the agent's wallet: a SOL or SPL transfer is signed only with a valid, unconsumed Blindseal
attestation for exactly that transfer. Private workspace package (not published).

```ts
import { SolanaAgentKit } from 'solana-agent-kit';
import { blindsealPlugin, connectionReader } from '@blindseal/agent-kit-plugin';

const agent = new SolanaAgentKit(wallet, rpcUrl, {})
  .use(blindsealPlugin({ chain: connectionReader(connection) }));

// hand the guard the attestation `blindseal attest` produced for the transfer the agent is about to make…
agent.methods.blindsealProvideAttestation(attestationJsonOrBase64);
// …then any plugin's transfer goes through the guarded wallet, or use the plugin's own action/method:
await agent.methods.blindsealTransfer(agent, { to, amount: '1000000', mint, attestation });
```

## What the guard does

`initialize(agent)` replaces `agent.wallet` with a wrapper. Before `signTransaction`,
`signAllTransactions`, `signAndSendTransaction` or `sendTransaction`, every transfer in the transaction
that is authorised by the agent's key — a System transfer, or an spl-token / token-2022 `Transfer` /
`TransferChecked` — must be covered by a stored attestation whose action equals it: same payer, same
recipient (for SPL the OWNER of the destination token account, read from a create-ATA instruction in the
same transaction or from the chain), same mint, same amount. The attestation then runs the shared check
(`@blindseal/attestation-check`): proof and action binding, not expired, nullifier not consumed on chain.
One attestation covers one transfer and is forgotten once the transaction is signed.

Refusals throw `TransferRefusedError` with a `code` and, when the cause is a field, the FIRST mismatched
one: `action_mismatch (amount)`, `action_mismatch (recipient)`, `action_mismatch (mint)`, …; or
`no_attestation`, `consumed`, `expired`, `invalid_proof`, `chain_unavailable`, `unreadable` (address
lookup tables, an SPL destination that does not exist), `other_instruction` (with
`otherInstructions: 'refuse'`). Transfers authorised by another key are not this wallet's to gate and pass;
instructions that are not transfers pass by default — compute budget, memo, swaps, program calls, and
also System `CreateAccount`, spl-token `Approve`, `CloseAccount` and `SetAuthority`, which can move or
delegate funds without being a transfer. Set `otherInstructions: 'refuse'` to sign nothing but attested
transfers (plus compute budget, memo and ATA creation).

The plugin exposes the methods `blindsealProvideAttestation`, `blindsealTransfer`,
`blindsealHeldAttestations` and the action `BLINDSEAL_GUARDED_TRANSFER` (`to`, `amount`, `mint?`,
`attestation`, `decimals?`), which builds the transfer, refuses early naming the first mismatched field,
and sends (or with `config.signOnly` signs) it through the guarded wallet.

## Dependencies

`solana-agent-kit` is NOT a dependency. Its `Plugin`, `Action` and `BaseWallet` shapes (v2,
`packages/core/src/types`) are copied here as structural TypeScript interfaces, so the plugin type-checks
against the real kit's `agent.use()` without pulling its runtime tree (LangChain, OpenAI agents, the
Vercel AI SDK) into this package. `zod` is a peer dependency (`^3.24.1`, the kit's own range): the kit's
`Action.schema` is a zod schema that its framework adapters introspect with `instanceof`, so the plugin
must build it with the same zod instance the kit uses. The package pins `zod@3.25.76` only as a
devDependency for its own tests. (GHSA-mrhx-c7xc-m3w5, unbounded-array issue accumulation in zod < 4.6.6,
does not reach this schema: it has no array.)

Tests: `pnpm test` (vitest; a fake wallet whose key is the 0.7.0 fixture's source authority so the real
proof covers a real transfer, and a fake chain).
