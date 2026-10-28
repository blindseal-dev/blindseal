# What Blindseal collects

Nothing, by default. The proxy has no telemetry: no collector, no install id, no network
calls other than the ones listed below.

## What stays on this machine

- Every decision the proxy makes — on tool-call arguments and on tool replies. The hash-chained
  audit log (`~/.blindseal/audit.log`) holds only fingerprints (hashes), ids and verdicts.
- What a decision was about (the tool-call arguments or the reply text) is kept only in an encrypted
  store (`~/.blindseal/content.json`, key in `~/.blindseal/content.key`), after best-effort redaction.
  So is the detectors' reasoning (an AI judge's explanation can quote the text it read). The agent
  only ever gets a fixed notice: tool, direction, verdict, layer and pattern ids.
  The stand-alone scan endpoint (`--transport scan-http`, `POST /scan`) answers with the same
  fields; it returns the reasoning only for `?verbose=1` with the dashboard token, and then marks
  it "may contain input text".
- Binary image and audio content (an image or audio item that is a valid file of its declared type)
  is passed to the agent without being screened. Every other embedded file is decoded and its text
  screened like any other text.
- Scan history (`BLINDSEAL_PERSIST=1`, `~/.blindseal/scans.db`) is local, opt-in and holds metadata
  only (tool, verdict, layer, fingerprint) — no text.
- The audit chain and scan history name the wrapped server by an identifier that holds no
  credentials: `stdio:<command>:<package or script name>` (never the value after a credential-looking
  flag such as `--api-key` or `--token`), or `http:<host>#<short hash>` for an upstream URL (never its path, query or
  user:password). The upstream URL is not printed in full either.
- The manifest check (on by default) keeps a fingerprint of each wrapped server's `initialize` and
  `tools/list` replies under `$XDG_CACHE_HOME/blindseal/manifests/` (default `~/.cache`; 0700
  directory, 0600 files). It stores a hash of the server's command line, never the command, its
  arguments or an upstream URL, so a credential passed as a flag is not kept on disk. Records an
  older version left behind are rewritten or removed each time the proxy starts.
- The dashboard (`blindseal run`) is served by the proxy itself on `127.0.0.1` behind a token in
  `~/.blindseal/dashboard.token`; it reads the local audit log and decrypts the store on this machine,
  and it never loads anything from the network.

## Network calls the proxy does make, and when

- **Embedding model download** — on first start the layer-2 model is downloaded from Hugging Face
  (or `BLINDSEAL_MODEL_HOST`) and cached. Nothing about your traffic is sent; `BLINDSEAL_MODEL_OFFLINE=1`
  never downloads.
- **Layer 3 judge** — off by default. It runs only if you set `BLINDSEAL_LAYER3_PROVIDER`. With
  `ollama` on this machine nothing leaves it. With a remote provider (`anthropic`, `openai`, `custom`,
  or an Ollama host elsewhere) the **redacted** tool output being judged is sent to that provider. An
  API key in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) never turns it on by itself. The
  active judge is printed at startup: `layer-3 judge: off | local | remote:<provider>`.
- **Solana RPC** (`BLINDSEAL_RPC_URL`, else the public mainnet endpoint) — `blindseal attest` fetches
  the current slot for the expiry; `blindseal submit` sends the gated transaction; the dashboard's
  nullifier lookups are proxied server-side. SHA-256 commitments only, never content.
- **Prover download** — `blindseal attest` fetches the prover binary from the GitHub release named in
  the package once, verifies its sha256, and caches it under `~/.blindseal/bin/`.
- **The MCP server you wrap** — `blindseal -- <server>` or `--transport http --upstream <url>`
  talks to the server exactly as your agent would have.

## What is never sent anywhere

- Tool output or tool-call arguments — except the redacted tool output a remote Layer 3 provider
  receives, if you chose one.
- User prompts or agent reasoning — Blindseal does not see these.
- Your environment variables or the audit log's contents.

Redaction is best effort: it replaces values under listed secret keys in JSON (`password`, `token`,
`api_key`, `secret`, `mnemonic`, …), key/token/secret value shapes (API keys, JWTs, private keys,
seed phrases, high-entropy strings), values under personal-data keys in JSON (`name`, `address`,
`phone`, `dob`, `ssn`, `passport`, `iban`, `account_number`, …) and some personal data by shape
(e-mail addresses, phone, card and SSN numbers). It does not find every secret, and names or
addresses written as free text (outside a JSON field) are not covered, so keep the judge local if
your tool output is sensitive. Redaction only changes what the model layers see: the payload a
proof hashes and the action it binds always come from the original tool call.
