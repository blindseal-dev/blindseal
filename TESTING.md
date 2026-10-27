# Testing Blindseal

Blindseal is a local MCP proxy that checks every request sent through it for prompt injection and, for
supported Solana actions, can produce a one-time zero-knowledge proof that the pattern checks passed.
Nothing to clone or build — the package is public on npm, so a tester needs only these commands.

## Try it in ~15 minutes

```bash
# 1. Watch the detection layers run against canned attacks
npx blindseal@latest demo
#    optional: export ANTHROPIC_API_KEY=sk-ant-...   # or OLLAMA_HOST=http://localhost:11434 — enables the L3 judge

# 2. Set up ~/.blindseal and open the dashboard over sample traffic
npx blindseal@latest init
npx blindseal@latest run --mock        # prints the dashboard URL with its token

# 3. Put Blindseal in front of any MCP server your agent uses
npx blindseal@latest -- npx -y @modelcontextprotocol/server-filesystem /data

# 4. Verify the sample proof — and watch a tampered copy fail — in your browser
#    https://blindseal.tech/verify
```

## What you can test locally (no wallet, no accounts)

| Capability | Works locally? | Needs |
|---|---|---|
| Four-layer detection (`demo`, wrapping any MCP server) | yes | nothing for L0–L2; an LLM key or local Ollama enables L3 |
| Redaction of secrets / PII before the model-based layers | yes | nothing |
| Capability firewall, manifest-drift check, local scan history | yes | nothing |
| Hash-chained audit log, `blindseal audit verify` / `disclose` | yes | nothing |
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

- **No API key?** Blindseal runs L0–L2 only. Detection of novel attacks drops sharply without L3 — this is
  documented in `packages/LIMITATIONS.md`, not hidden.
- **It's a transparent proxy.** Your agent talks to Blindseal instead of the server; every tool response is
  checked before your agent reads it. Nothing is sent to Blindseal's website.
- **What the proof covers:** the committed L1 rules only, bound to one action and usable once. See
  `packages/SECURITY_MODEL.md`.
