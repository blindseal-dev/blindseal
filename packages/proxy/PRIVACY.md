# What Blindseal collects

Nothing, by default. The proxy has no telemetry: no collector, no install id, no network
calls other than the ones a command explicitly makes on your behalf.

## What stays on this machine

- Every decision, verdict, and hash the proxy produces. The hash-chained audit log
  (`~/.blindseal/audit.log`) is content-free and local.
- Scan history (`BLINDSEAL_PERSIST=1`, `~/.blindseal/scans.db`) is local and opt-in.
- The dashboard is served by the proxy itself on `127.0.0.1` behind a token in
  `~/.blindseal/dashboard.token`; it never loads anything from the network.

## Network calls the proxy does make, and when

- **Layer 3 judge** — only if you configure a key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or
  `OLLAMA_HOST`. The judged text is the tool output being screened; it goes to the provider you chose.
- **Solana RPC** (`BLINDSEAL_RPC_URL`, else the public mainnet endpoint) — `blindseal attest` fetches
  the current slot for the expiry; `blindseal submit` sends the gated transaction; the dashboard's
  nullifier lookups are proxied server-side. SHA-256 commitments only, never content.
- **Prover download** — `blindseal attest` fetches the prover binary from the GitHub release named in
  the package once, verifies its sha256, and caches it under `~/.blindseal/bin/`.
- **The MCP server you wrap** — `blindseal -- <server>` or `--transport http --upstream <url>`
  talks to the server exactly as your agent would have.

## What is never sent anywhere

- Raw tool output or tool-call arguments (outside the Layer 3 provider you opted into)
- User prompts or agent reasoning — Blindseal does not see these
- API keys, credentials, environment variables
- Personally identifying information
