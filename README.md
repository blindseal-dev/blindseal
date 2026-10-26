# Blindseal

**Prove an agent's action was screened — without showing what it was.**

Blindseal is a privacy-preserving, verifiable screening layer for AI agents. It sits between an agent and its
tools as a local MCP proxy, inspects every tool call with four layers of prompt-injection detection before the
call executes, and — when something downstream needs proof — produces a zero-knowledge attestation that a
specific call passed a committed policy. The attestation is verified by one Solana instruction. Nothing sensitive
leaves the machine: not the prompt, not the tool arguments, not the policy, not which agent was screened.

- Site and docs: **https://blindseal.tech** (quickstart, concepts, hashing spec, gated-program guide, scope, verify page)
- Verifier program (Solana mainnet): `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`
- Example consumer (transfer-gate): `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa`
- Security contact: **blindseal@proton.me** (see `SECURITY.md`; both programs carry a neodyme security.txt)

## What is proven — and what is not

The proof covers **L1 today** — the committed deterministic rule automata. It states: *this payload (by hash) was
screened by this detector version under the policy with this root, the committed L1 rules found it clean, and the
screening is bound to one on-chain action, one expiry and one nonce — usable once.* **L0** (decode-then-L1) runs in
the proxy but is **not inside the proof yet**; it is the next increment and will change the detector version. The
model-based layers **L2/L3** (embeddings, LLM judge) run locally or in a TEE and are **attested, not proven**.
Blindseal does not prove an agent is safe, and it does not cover traffic that does not pass through the proxy. CPU proving takes hours, so v1 is prove-then-act, not real-time gating; faster proving is M4.
Proving takes hours on CPU: the sample attestation took 2 h 16 min on an Apple M1 Max (32 GB). The honest numbers
are in `packages/LIMITATIONS.md`, `docs/performance.md` and on the docs "What is proven" page.

## Quickstart

Node ≥ 20; no Rust or Solana toolchain needed (the verifier ships as WebAssembly). Three unscoped packages on npm:
`blindseal` (proxy + CLI), `blindseal-sdk`, `blindseal-verifier-wasm`.

```sh
npm i -g blindseal                 # or prefix every command with npx: npx blindseal …
blindseal init                     # scaffolds ~/.blindseal: identity keys, the default policy, the dashboard token
blindseal run --mock               # local API + dashboard on http://127.0.0.1:7777 over sample traffic (the token is printed)
```

Put the proxy in front of a real MCP server (wrapping needs the `--`; `blindseal init --wrap` rewrites the MCP
configs it finds):

```sh
blindseal -- <your-mcp-server-command>
```

Attest a screened action and verify it anywhere. `call.json` is the tool call to screen — for the transfer gate: `{ "toolName": "transfer_sol", "args": { "from": "<source authority>", "to": "<recipient>", "lamports": 1000000 } }` (proving takes hours on CPU; the prover downloads on first use):

```sh
blindseal attest call.json --target-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa --out attestation.json
#   proving takes hours on CPU (2 h 16 min for the sample on an M1 Max); the prover binary is downloaded from the
#   project's GitHub release on first use, or build it from source (below) and pass --prover <path>
blindseal verify attestation.json          # off-chain, the wasm verifier
blindseal submit attestation.json          # Solana mainnet: verifies on chain, consumes the nullifier
blindseal submit attestation.json --check  # has this nullifier been consumed?
```

Or drop `attestation.json` on the site's verify page — the same verifier runs in your browser and uploads nothing.
`blindseal audit verify` checks the local audit chain; `blindseal dashboard` reopens the dashboard.

### From source

```sh
git clone https://github.com/blindseal-dev/blindseal && cd blindseal
./scripts/quickstart.sh          # pnpm install, build the dashboard, verify the sample attestation (real Groth16) and reject a tampered copy
BLINDSEAL_MOCK=1 pnpm -C packages/proxy exec tsx src/index.ts run --mock
```

Rust / Solana / Anchor toolchains are needed only for these:

```sh
scripts/build-programs.sh                      # the Anchor programs (cargo build-sbf + anchor idl build)
cargo build --release -p blindseal-prover      # the prover; pass it to `blindseal attest --prover`
cd programs && solana-verify build -b solanafoundation/solana-verifiable-build:4.3.0 --library-name blindseal_verify   # reproduce the deployed bytes (also transfer_gate)
```

The docs page "From source" (`/docs/source`) walks through each step.

## How it works

```
agent ──► proxy (127.0.0.1) ──► upstream MCP server
             │
             ├─ L1 rules (committed DFAs — PROVEN)
             ├─ L0 decode-then-L1 (deterministic; in the proxy, not in the proof yet)
             ├─ redaction of secrets / PII
             ├─ L2 embeddings + L3 judge (ATTESTED; local or TEE)
             ├─ hash-chained audit log (content-free; signed disclosures)
             └─ on demand: SP1 → Groth16 attestation ──► Solana verifier ──► gated program
```

- **Policy** is a Merkle root over the committed rule automata; the rules never leave the operator's machine.
- **Attestation** = proof + six public inputs: `payloadHash`, `policyRoot`, `detectorVersion` (the vkey),
  `actionHash`, `nullifier`, `expirySlot`. Spec: `BLINDSEAL.md` §3; hashing: `docs/hashing`.
- **On chain**: the verifier checks the proof, the allowlists and the expiry, and records the nullifier so the
  attestation cannot be replayed. Any program can gate an action on it via CPI (see `programs/transfer-gate`).
- **Audit**: every decision is appended to a hash chain; a disclosure proves a window was clean without exposing
  traffic.

## Repository

| Path | What |
|---|---|
| `packages/proxy` | the MCP proxy + CLI (`blindseal`) |
| `packages/sdk` | build the verify instruction, submit, verify off-chain (`blindseal-sdk`) |
| `packages/verifier-wasm` | the Groth16 verifier compiled to WebAssembly (`blindseal-verifier-wasm`) |
| `packages/redactor`, `packages/audit`, `packages/chain-reads` | redaction, audit chain + disclosures, mainnet reads |
| `packages/dashboard` | the local dashboard the proxy serves |
| `crates/` | detector core (Rust, DFA rules), SP1 guest, prover, verifier |
| `programs/` | Anchor programs: `blindseal-verify`, `transfer-gate` |
| `apps/site` | the public site (Next.js) |
| `docs/` | hashing spec, integration guide, performance numbers, launch checklist |

Build the programs with `scripts/build-programs.sh`; run the on-chain suite with `scripts/test-m2.sh`.
Deployed bytes reproduce with `solana-verify` from this repository at the tagged commit (see "From source" above and `docs/LAUNCH-CHECKLIST.md`).

## Upgradeability

Both programs keep an upgrade authority, held today by a single key. Every upgrade is logged with its
signature in `docs/internal/REPORT.md`; moving the authority to a Squads multisig with a timelock is on the roadmap.
Treat the authority as the trust root it is.

## Lineage and license

MIT. The detection layers and the red-team corpus derive from the MIT-licensed Blindseal proxy; the redaction
step, the zero-knowledge attestation, the Solana verifier and the audit chain are Blindseal's.
