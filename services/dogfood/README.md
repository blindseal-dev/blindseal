# services/dogfood

A small agent that uses Blindseal the way a real agent would, on a timer, on Solana mainnet: every tick it buys
one paid resource over x402 (HTTP 402, Solana USDC) and asks for one small SOL transfer, both through the
Blindseal proxy, then proves the screened transfer call (`blindseal attest`), sends it through transfer-gate
(`blindseal submit`) and appends one line to a JSONL log. It exists so the project's own mainnet footprint is
produced by the shipped tooling, continuously, and so a regression in any part of the chain shows up here first.

It has a dry-run mode with no network side effects, which is the only mode that has been run so far.

## What a tick does

```
caps ──► proxy ──► buy_resource ──► transfer_sol ──► attest ──► submit ──► log
```

0. **caps** — sums the last 24 h of `dogfood.jsonl`; if the purchase or the transfer (amount + `txOverheadLamports`)
   would break `maxUsdcPerDay` / `maxSolPerDay`, the tick is logged as `capped` and nothing else happens.
1. **proxy** — starts `blindseal` (block mode, layers 0–2, trade guard with the recipient allowlisted) in front of
   this service's own MCP server (`src/mcp/server.ts`), which has two tools.
2. **buy_resource** — `tools/call` through the proxy. The server pays for the one configured URL with the
   [x402-solana](https://www.npmjs.com/package/x402-solana) client (price capped by what is left of the daily USDC
   budget, payTo optionally allowlisted) and returns the receipt **and the resource body**. The body is untrusted
   content, so it goes back through the proxy's reply screen: an injected body is blocked and the tick ends as
   `blocked` (tested).
3. **transfer_sol** — `tools/call` through the proxy with `{ to, lamports, from, memo }`. The server moves nothing;
   it validates the request and echoes the canonical call. Execution is gated by the proof.
4. **attest** — `blindseal attest toolcall.json --out attestation.json`: the proven layers re-screen the call, the
   decision goes on the audit chain, the prover runs. The CUDA prover (`linux-x64-cuda` asset in
   `packages/proxy/src/prover/manifest.json`) is used when `nvidia-smi` answers and the manifest has the asset;
   otherwise the CLI resolves the CPU prover as usual (hours).
5. **submit** — `blindseal submit attestation.json --check` (an already-consumed nullifier stops here), then
   `blindseal submit attestation.json --wallet <keypair>`: transfer-gate verifies the proof, consumes the nullifier
   and executes the transfer in one transaction.
6. **log** — one line in `<dataDir>/dogfood.jsonl`.

### Dry run (`--dry-run` or `"dryRun": true`)

The same code path, with every side effect replaced:

| Step | Live | Dry run |
|---|---|---|
| merchant + RPC for the payment | the configured `x402.resourceUrl`, `$BLINDSEAL_RPC_URL` | an in-process mock (`src/mock/x402-server.ts`): x402 v2 402/200 and a tiny Solana JSON-RPC (mint, token accounts, blockhash); nothing is broadcast |
| payer key | `walletPath` | an ephemeral in-memory keypair, never written |
| proxy screening | real | **real** — the tool calls and the resource body go through the same proxy |
| attest | prover | copies `tests/fixtures/attestation-mainnet-demo-0.7.0.json` |
| submit | gated transfer on mainnet | reports that fixture's known consume signature (`2HrABCZY…mCFj26`, see `docs/release-0.7.0-notes.md`), flagged `simulated: true` |
| proxy state | `~/.blindseal` (dashboard sees it) | `<dataDir>/audit`, `<dataDir>/manifest-cache`, scan history off |
| log | `dryRun: false` | `dryRun: true`; the caps count dry-run entries against dry-run ticks only |

Dry run needs no wallet, no resource URL and no RPC.

## Run the dry run now

```sh
pnpm install --frozen-lockfile
pnpm --filter './packages/**' --filter '!@blindseal/corpus' build   # blindseal-sdk, then the proxy bundle
cd services/dogfood
pnpm dogfood --dry-run --once --data-dir /tmp/dogfood-dry          # one tick
pnpm dogfood --dry-run --data-dir /tmp/dogfood-dry --interval-hours 0.1   # the timer, every 6 minutes
```

The first proxy start downloads the layer-2 embedding model (once, ~33 MB). `pnpm test` runs the dry-run end to
end through the real proxy, the injected-body case, the caps and the x402 client against the mock.

## Fund and start live (morning checklist)

Nothing here creates a wallet. The service refuses to start live until the keypair exists and names the path.

1. Create or copy the funded keypair to `~/.blindseal/dogfood-wallet.json` (or set `walletPath`). It needs SOL for
   the transfers (0.001 SOL + ~0.0011 SOL fee and nullifier rent per tick by default) and a USDC associated
   token account with balance for the purchases (the x402 client refuses to pay without one).
2. Copy `dogfood.config.example.json` to `dogfood.config.json` and set `x402.resourceUrl` (the one paid resource),
   `recipient`, and the caps. `dogfood.config.json` is git-ignored. Never put the RPC URL in it.
3. Export `BLINDSEAL_RPC_URL` (the public endpoint works but is rate-limited; the attest step needs one `getSlot`,
   submit a few calls).
4. Check it refuses correctly first: `pnpm dogfood --once` without the wallet prints the error and exits 1.
5. Start the timer. `nohup`:
   ```sh
   cd services/dogfood && pnpm build
   BLINDSEAL_RPC_URL="$(cat ~/.blindseal/rpc-url)" nohup node dist/main.js --config dogfood.config.json \
     >> ~/.blindseal/dogfood/stdout.log 2>&1 &
   ```
   or a `systemd` user unit (`~/.config/systemd/user/blindseal-dogfood.service`, then `systemctl --user enable --now blindseal-dogfood`):
   ```ini
   [Unit]
   Description=Blindseal dogfood agent
   After=network-online.target

   [Service]
   WorkingDirectory=%h/code/blindseal/services/dogfood
   Environment=BLINDSEAL_RPC_URL=...
   ExecStart=/usr/bin/node dist/main.js --config dogfood.config.json
   Restart=on-failure
   RestartSec=60

   [Install]
   WantedBy=default.target
   ```
   The interval is 6 h by default (`intervalHours`). A tick still proving when the next one is due is not
   overlapped; the timer skips and says so. `SIGTERM` kills the step's child processes (prover included).

Set `"prover": { "cuda": "auto" }` (default) for the CUDA prover on a machine with `nvidia-smi`; `"never"` forces
CPU; `"always"` fails loudly when the asset is missing from the manifest.

## What gets logged

`<dataDir>/dogfood.jsonl` (default `~/.blindseal/dogfood/dogfood.jsonl`), append-only, mode 0600, one JSON object
per tick:

| Field | Meaning |
|---|---|
| `ts`, `finishedAt`, `tick` | timestamps and the tick id (also the per-tick directory `<dataDir>/ticks/<tick>/` with `toolcall.json` and `attestation.json`) |
| `dryRun` | `true` for dry-run ticks |
| `status` | `ok`, `blocked` (the proxy refused a call or a reply), `failed` (with `error`), `capped` (with the cap that stopped it) |
| `wallet` | the source authority (public key) |
| `steps.{buy,transfer,attest,submit}` | start/finish/ok per step |
| `x402` | resource, `paid`/`free`, price (USDC atomic units), asset, payTo, network and the decoded `PAYMENT-RESPONSE` receipt |
| `attestation` | file, decisionId, nullifier, payloadHash, expirySlot, which prover |
| `signature` | the gated transfer's signature; `simulated: true` in dry run |
| `spend` | lamports (amount + overhead) and USDC the tick cost; what the caps sum |
| `blocked` | tool, direction (`request`, `response`, `capability`) and the proxy's notice |
| `proxyNotices` | the proxy's stderr verdict lines, bounded |

No key, token or RPC URL is ever logged or printed.

## Explorer

The site's explorer reads consumed nullifiers from the verifier program on mainnet; the dogfood wallet's
transfers show up there like any other. The site labels this wallet as internal/dogfood and keeps it out of the
totals through the config key `BLINDSEAL_DOGFOOD_WALLET` (the wallet's public key), which its treasury tab reads.
Set it to the public key of `~/.blindseal/dogfood-wallet.json` wherever the site is deployed.

## The x402 client

`x402-solana` 3.0.1 (PayAI's SDK) was chosen because it is built on `@solana/web3.js`, which this repository
already pins at 1.98.4, supports Solana USDC with the `exact` scheme (x402 v2, CAIP-2 networks, with v1 fallback),
takes a plain `{ address, signTransaction }` wallet (so a Keypair works without a browser adapter), has a
`beforePayment` hook (payTo allowlist) and an `amount` cap enforced before anything is signed, and accepts an
`rpcUrl`, which is what lets the dry run point it at the mock. The alternative v2 stack (`@x402/fetch` +
`@x402/svm`) would have added `@solana/kit`, a second Solana client library; the other named vendor publishes no
x402 client on npm. Two advisories in its dependency tree are triaged in `SECURITY.md` ("Not reachable,
allowlisted") and `scripts/audit-allowlist.json`.

## Layout

```
src/main.ts            CLI and timer
src/tick.ts            one tick, the steps above
src/config.ts          config file, flags, live preflight
src/ledger.ts          daily caps over the log
src/log.ts             the JSONL log
src/proxy.ts           the agent side of the proxy's stdio pipe; recognises the proxy's refusals
src/steps.ts           blindseal attest / submit as child processes; dry-run stand-ins
src/prover.ts          CUDA prover selection (nvidia-smi + manifest asset), else the CLI's own resolution
src/wallet.ts          keypair file → public key (the secret stays with the signers)
src/mcp/server.ts      the MCP server behind the proxy: buy_resource, transfer_sol
src/mock/x402-server.ts the dry-run merchant and mock RPC
test/                  vitest: dry-run e2e (clean and injected), caps, config, x402 client vs mock
```
