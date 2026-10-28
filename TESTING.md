# Testing Blindseal

Blindseal is a local MCP proxy that checks the tool calls your agent sends and the replies tools send back for
prompt injection and, for
supported Solana actions, can produce a one-time zero-knowledge proof that the pattern checks passed.
Nothing to clone or build — the package is public on npm, so a tester needs only these commands.

## Try it in ~15 minutes

```bash
# 1. Watch the detection layers run against canned attacks
npx blindseal@latest demo
#    optional: BLINDSEAL_LAYER3_PROVIDER=ollama (a local model) enables the L3 judge; a remote provider
#    (anthropic | openai | custom, with its key) sends redacted tool output to that provider. A key alone does nothing.

# 2. Set up ~/.blindseal and open the dashboard
npx blindseal@latest init
npx blindseal@latest run               # your own decisions (empty until step 3); prints the URL with its token
#    npx blindseal@latest run --mock   # the same dashboard over bundled sample data

# 3. Put Blindseal in front of any MCP server your agent uses
npx blindseal@latest -- npx -y @modelcontextprotocol/server-filesystem /data

# 4. Verify the sample proof — and watch a tampered copy fail — in your browser
#    https://blindseal.tech/verify
```

## What you can test locally (no wallet, no accounts)

| Capability | Works locally? | Needs |
|---|---|---|
| Four-layer detection (`demo`, wrapping any MCP server) | yes | L0–L1: nothing; L2: a one-time download of the embedding model (block mode will not start without it unless `--allow-degraded`); L3: `BLINDSEAL_LAYER3_PROVIDER` (a local Ollama model, or a remote provider and its key) |
| Best-effort redaction before the model-based layers (listed secret keys, key/token shapes, common PII) | yes | nothing |
| Capability firewall, manifest-drift check, local scan history | yes | nothing |
| Hash-chained audit log, `blindseal audit verify` / `disclose`, the live dashboard (`blindseal run`) | yes | nothing |
| Off-chain proof verification (`blindseal verify`, the verify page) | yes | nothing |
| Producing a proof (`blindseal attest`) | yes | hours of CPU time; the prover downloads on first use |
| On-chain verification (`blindseal submit --wallet`) | Solana mainnet | a funded wallet and a fresh attestation |

## What we'd love feedback on

1. **False positives** on your real tool traffic — anything benign that got flagged.
2. **README confusion** — anything unclear or that made you bounce.
3. **Demo clarity** — does `npx blindseal@latest demo` make sense in under a minute?

## Where to send it

- **Bugs / feedback:** <https://github.com/blindseal-dev/blindseal/issues>
- **Security / vulnerabilities:** blindseal@proton.me (see [SECURITY.md](SECURITY.md))
- **Code + eval methodology:** <https://github.com/blindseal-dev/blindseal> — the red-team corpus, the
  benign set and the known limitations (`packages/LIMITATIONS.md`) are public.

## Good to know

- **No L3?** L3 is off unless you set `BLINDSEAL_LAYER3_PROVIDER`; Blindseal then runs L0–L2 only. Detection of
  novel attacks drops sharply without L3 — this is documented in `packages/LIMITATIONS.md`, not hidden.
- **It's a transparent proxy.** Your agent talks to Blindseal instead of the server; every tool call's arguments
  are checked before the server gets them, and every tool reply before your agent reads it. Nothing is sent to
  Blindseal's website.
- **What the proof covers:** the committed L1 rules only, bound to one action and usable once. See
  `packages/SECURITY_MODEL.md`.
