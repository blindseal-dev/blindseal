# Blindseal

**AI agents can be tricked. Blindseal helps stop them.**

Blindseal checks your AI agent's requests for hidden threats and can provide proof that specific checks passed, without
revealing your instructions or security rules. Blindseal runs the checks on your computer and can create a proof for
supported actions. Apps can check that proof before accepting your agent's request.

It runs on your computer between the AI agent and its tools, as a local MCP proxy. It checks both directions: the
arguments of every tool call your agent sends, and every message the server sends back — every string in it, keys
and values at any depth, single messages and batches — before passing it on. A reply that answers no request the
agent made, or does not have the shape the protocol requires, never reaches the agent. In block mode, anything that
fails the checks is replaced by a fixed notice built by Blindseal (tool, verdict, layer and pattern ids; no detector
reasoning and nothing from the original). Embedded files are decoded and their text checked; binary image and audio
content (a valid image or sound file of its declared type, in the formats listed in `packages/LIMITATIONS.md` §15:
PNG, JPEG, GIF, WebP, BMP, ICO, TIFF; WAV, AIFF, MP3, AAC, FLAC, Ogg) is not screened. For supported actions that pass, your
computer can create a zero-knowledge proof that the pattern checks passed, tied to the exact action and the rule set
used. A Solana program verifies the proof and records it, so it can be used only once.

Today's proof covers checks for known attack patterns. It does not guarantee that an action is safe.

- Site and docs: **https://blindseal.tech** (quickstart, concepts, hashing spec, gated-program guide, scope, verify page)
- Verifier program (Solana mainnet): `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`
- Example consumer (transfer-gate): `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa`
- Security contact: **blindseal@proton.me** (see `SECURITY.md`; both programs carry a neodyme security.txt)

## What is proven — and what is not

The proof covers **L0 and L1** from release 0.8.0 (on mainnet since 2026-11-05; the 0.7.0 detector version, which
covered L1 only, is no longer allowed on chain). It states: *this payload (by hash) was screened by this detector version under the policy with this root;
the committed L1 rules found it clean on the raw text, on every JSON string in it (keys and values, unescaped) and
on every decoded variant of each (base64, hex, URL, HTML entities, zero-width strip, NFKC, homoglyph fold, nested to
depth 3); the bound action satisfies the action policy the root commits to (allowed recipients, programs,
instructions and mints, a maximum amount — any of them optional); and the screening is bound to one on-chain
action, one expiry and one nonce — usable once.* Proofs made before 0.8.0 screened the serialized call as raw text
only, so an injection hidden behind a JSON escape (`\n`, `\t`, `\u0069`) in an argument could pass them; the 0.7.x
live proxy, which reads each string of a call's arguments, was not affected (earlier proxies did not screen arguments).

What the proof alone catches, measured as the proof sees it: **2.5 % of the true holdout** (2 of 80 attacks never
used to write the rules) and 29.0 % of the red-team set (9 of 31), with 0.5 % false positives on 210 benign samples
(`evals/results/catch-rate-0.8.0.md`). Detection in practice leans on the model-based layers **L2/L3**
(embeddings, LLM judge), which are **attested, not proven**: embeddings run locally, and the judge is off unless you turn it on (locally,
or at a provider you choose); a TEE mode is planned. Blindseal does not prove an agent is safe, and it does not cover
traffic that does not pass through the proxy. Proving takes hours on CPU — the 0.8.0 mainnet sample took 2 h 19 min
on an Apple M1 Max (32 GB) — so v1 is prove-then-act, not real-time gating; local GPU proving (`--mode cuda`) is the
fast path. The honest numbers are in `packages/LIMITATIONS.md`, `docs/performance.md` and on the docs "What is
proven" page.

## Quickstart

Node ≥ 20; no Rust or Solana toolchain needed (the verifier ships as WebAssembly). Three unscoped packages on npm:
`blindseal` (proxy + CLI) and `blindseal-sdk` at 0.7.0, `blindseal-verifier-wasm` at 0.5.2.

```sh
npm i -g blindseal                 # or prefix every command with npx: npx blindseal …
blindseal init                     # scaffolds ~/.blindseal: identity keys, the default policy, the dashboard token
blindseal run                      # local API + dashboard on http://127.0.0.1:7777 over YOUR decisions (the token is printed)
blindseal run --mock               # the same dashboard over bundled sample data, for a look before you wrap anything
```

What to expect on first run:

- The first start downloads the embedding model used by layer 2 (from Hugging Face; `BLINDSEAL_MODEL_HOST` /
  `BLINDSEAL_MODEL_DIR` for a mirror or an offline cache). In the default `block` mode the proxy refuses to start
  (exit code 4) if that model cannot load, unless you pass `--allow-degraded`; decisions made without it are marked
  degraded.
- The AI judge (layer 3) is **off by default**. It runs only if you set `BLINDSEAL_LAYER3_PROVIDER`: point it at a local
  model (`ollama`) and nothing leaves your machine; choose a remote provider (`anthropic`, `openai`, `custom`) and the
  redacted tool output is sent to that provider. An API key in your environment never turns it on by itself. The proxy
  prints which judge is active at startup (`layer-3 judge: off | local | remote:<provider>`).

Put the proxy in front of a real MCP server (wrapping needs the `--`; `blindseal init --wrap` rewrites the MCP
configs it finds):

```sh
blindseal -- <your-mcp-server-command>
```

Attest a screened action and verify it anywhere. `call.json` is the tool call to screen — for the transfer gate: `{ "toolName": "transfer_sol", "args": { "from": "<source authority>", "to": "<recipient>", "lamports": 1000000 } }` (proving takes hours on CPU; the prover downloads on first use). `attest` refuses, before proving, a call that does not describe exactly the action the proof would approve:

```sh
blindseal attest call.json --target-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa --out attestation.json
#   proving takes hours on CPU (2 h 16 min for the sample on an M1 Max); the prover binary is downloaded from the
#   project's GitHub release on first use, or build it from source (below) and pass --prover <path>
blindseal verify attestation.json                        # off-chain, the wasm verifier
blindseal submit attestation.json --wallet source.json   # Solana mainnet: the gated transfer (verify + consume + transfer)
blindseal submit attestation.json --check                # has this nullifier been consumed?
```

Or drop `attestation.json` on the site's verify page — the same verifier runs in your browser and uploads nothing.
`blindseal audit verify` checks the local audit chain; `blindseal dashboard` opens the dashboard (starting `blindseal run`
if nothing is listening).

### Proving modes

`blindseal attest` makes the proof on your machine. The prover has two modes (`--mode`, or the env
`BLINDSEAL_PROVER_MODE`; `attest` passes the right one), and the payload never leaves the machine in either:

| mode | where the proof is made |
|---|---|
| `cpu` (default) | this machine, CPU |
| `cuda` | this machine, an NVIDIA GPU (the prover built with the `cuda` feature plus SP1's Moongate GPU server; `attest` picks it on linux-x64 when `nvidia-smi` works and the cuda asset is released) |

Every attestation records how it was made under `prover: { mode, host, version }`. `crates/prover/Dockerfile.cuda` is
the GPU build for a rented box (`docs/gpu-proving.md`). The hosted prover (`services/prover-host`) is a separate,
opt-in service: it proves on its operator's hardware and therefore sees the payload you send it.

### From source

```sh
git clone https://github.com/blindseal-dev/blindseal && cd blindseal
./scripts/quickstart.sh          # pnpm install, build the dashboard, verify the sample attestation (real Groth16) and reject a tampered copy
pnpm -C packages/proxy exec tsx src/index.ts run        # the dashboard over your local decisions (add --mock for sample data)
```

Rust / Solana / Anchor toolchains are needed only for these:

```sh
scripts/build-programs.sh                      # the Anchor programs (cargo build-sbf + anchor idl build)
cargo build --release --manifest-path crates/prover/Cargo.toml   # the prover → crates/prover/target/release/blindseal-prover; pass it to `blindseal attest --prover`
#   add --features cuda (GPU, see "Proving modes") or --features network (remote proving, opt-in at run time)
cd programs && solana-verify build -b solanafoundation/solana-verifiable-build:4.3.0 --library-name blindseal_verify   # reproduce the deployed bytes (also transfer_gate)
```

The docs page "From source" (`/docs/source`) walks through each step.

## How it works

```
agent ──► proxy (127.0.0.1) ──► upstream MCP server
             │
             ├─ checks tool-call arguments (L0 + L1) and tool replies (all four layers)
             ├─ L1 rules (committed DFAs — PROVEN)
             ├─ L0 decode-then-L1 (deterministic — PROVEN from 0.8.0)
             ├─ best-effort redaction (listed secret keys, key/token shapes, common PII)
             ├─ L2 embeddings (local) + L3 judge (off unless BLINDSEAL_LAYER3_PROVIDER is set) — ATTESTED
             ├─ hash-chained audit log (fingerprints + verdicts; content encrypted locally; signed disclosures)
             └─ on demand: SP1 → Groth16 attestation ──► Solana verifier ──► gated program
```

- **Policy** is a Merkle root over the committed rule automata; the rules never leave the operator's machine.
- **Attestation** = proof + six public inputs: `payloadHash`, `policyRoot`, `detectorVersion` (the vkey),
  `actionHash`, `nullifier`, `expirySlot`. Hashing spec: https://blindseal.tech/docs/hashing.
- **Payload ↔ action**: before hashing, the guest parses the screened tool call and asserts it describes exactly
  the action the proof binds (program, instruction, source, recipient, mint, amount); otherwise no proof exists.
- **On chain**: the verifier checks the proof, the allowlists (approved policies on by default) and the expiry, and records the nullifier so the
  attestation cannot be replayed (the exact check order is in the header of `programs/blindseal-verify/src/lib.rs`). Any program can gate an action on it via CPI (see `programs/transfer-gate`).
- **Redaction** is best effort: before L2/L3 see a reply, values under listed secret keys in JSON (`password`,
  `token`, `api_key`, `secret`, `mnemonic`, …), key/token/secret value shapes (API keys, JWTs, private keys, seed
  phrases, high-entropy strings), values under personal-data keys in JSON (`name`, `address`, `phone`, `dob`,
  `ssn`, `passport`, `iban`, `account_number`, …) and some PII shapes (e-mail, phone, card and SSN numbers) are
  replaced. It does not find every secret, and names or addresses written as free text (outside a JSON field) are
  not covered.
- **Audit**: every decision (tool calls, replies, capability checks, errors) is appended to a hash chain that holds
  only fingerprints and verdicts; what a decision was about is kept redacted and encrypted on your machine. A
  disclosure proves a window was clean without exposing traffic. The dashboard (`blindseal run`) reads this chain.

## Repository

| Path | What |
|---|---|
| `packages/proxy` | the MCP proxy + CLI (`blindseal`) |
| `packages/sdk` | build the verify instruction, submit, verify off-chain (`blindseal-sdk`) |
| `packages/verifier-wasm` | the Groth16 verifier compiled to WebAssembly (`blindseal-verifier-wasm`) |
| `packages/redactor`, `packages/audit`, `packages/chain-reads` | redaction, audit chain + disclosures, mainnet reads |
| `packages/attestation-check`, `packages/x402-gate`, `packages/agent-kit-plugin` | reference consumers: the shared off-chain check (proof, action, expiry, nullifier), an x402 facilitator gate, a Solana Agent Kit plugin that guards transfer signing |
| `packages/dashboard` | the local dashboard the proxy serves |
| `crates/` | detector core (Rust, DFA rules), SP1 guest, prover, verifier |
| `programs/` | Anchor programs: `blindseal-verify`, `transfer-gate`, `payout-gate` (batch SPL payouts, one attestation each) |
| `apps/site` | the public site (Next.js) |
| `docs/` | performance numbers, the local API data contract, release plans; `docs/design/` holds proposals that are not built (session proofs, a prover network) |

Build the programs with `scripts/build-programs.sh`; run the on-chain suite with `scripts/test-m2.sh`.
Deployed bytes reproduce with `solana-verify` from this repository at the tagged commit (see "From source" above).

## Upgradeability

Both programs keep an upgrade authority, held today by a single key. Upgrades are announced in the release
notes (https://blindseal.tech/changelog) and `solana-verify` checks the deployed bytes against this repository; moving the authority to a Squads multisig with a timelock is on the roadmap.
Treat the authority as the trust root it is.

## License

MIT — see `LICENSE`.
