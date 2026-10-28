# Blindseal — Security Model

This page describes, in plain terms, what Blindseal does, what it proves, what it does not, what it
assumes about its environment, and what an attacker still has to do with Blindseal deployed. The
specific detection gaps, with red-team evidence, are in [`LIMITATIONS.md`](./LIMITATIONS.md).

> Blindseal proves that a specific call was screened under a committed policy by a specific detector
> version, and that the committed L1 rules passed. L0 decoding is run by the proxy but is not inside the
> proof yet; the model-based layers run locally and are attested, not proven (a TEE mode is planned).
> Blindseal does not prove an agent is safe, and does not cover traffic that doesn't pass through the proxy.

## What Blindseal is

A local MCP proxy. It runs on the operator's machine between an AI agent and its tools
(`blindseal -- <mcp-server-command>`, or `blindseal init --wrap` to route existing MCP configs through
it) and checks every request sent through it before passing it on. In `block` mode a request or tool
response that fails the checks is replaced with a `[BLINDSEAL_BLOCKED]` error; `warn` and `log` modes let
traffic through and only record the verdict.

For supported on-chain actions that pass, the operator's machine can produce a zero-knowledge proof that
the pattern checks passed, and a Solana program can require that proof before it executes the action.

## The four detection layers

| Layer | What it does | Where it runs | In the proof? |
|---|---|---|---|
| **L0** | Decode-then-L1: base64, hex, URL-percent and HTML-entity encodings are decoded and the result is re-run through L1. | the proxy | not yet (the next increment; it will change the detector version) |
| **L1** | Deterministic rules: instruction overrides, unicode-tag smuggling, bidi controls, zero-width density, HTML-entity runs, markdown-link exfiltration and similar. Compiled to DFAs (`crates/detector-core`) that the SP1 guest runs; byte-for-byte parity with the TypeScript rules is enforced against `evals/vectors/parity.json`. | the proxy and the SP1 guest | **yes** |
| **L2** | Embedding similarity (`bge-small-en-v1.5`, run locally) against the public red-team corpus. | the proxy | no — attested |
| **L3** | An LLM judge (Anthropic, OpenAI-compatible, or a local Ollama model); off without a key or host. | the proxy, or the provider you configure | no — attested |

Two optional gates run alongside the layers: the **capability firewall** (`BLINDSEAL_CAPABILITY=1`), which
blocks tokens that flowed out of a tool response from reaching a sensitive tool call, and **manifest
verification** (`BLINDSEAL_MANIFEST_CHECK=on`, the default), which flags an upstream server that adds,
removes or changes a tool between sessions.

## Redaction

Before the model-based layers see anything, the redactor (`packages/redactor`) strips secrets and PII
(API keys, JWTs, private keys, seed phrases, high-entropy strings, e-mail addresses, phone, card and SSN numbers) from the text. L0 and L1 run
on the raw text; L2 and L3 run on the redacted text, so an L3 provider never receives raw credentials.

## The proof and what the chain checks

`blindseal attest` takes a screened tool call that maps to a supported Solana action and produces an
SP1 proof, wrapped to Groth16, over six public inputs: `payloadHash`, `policyRoot`, `detectorVersion` (the
SP1 verifying key), `actionHash`, `nullifier` and `expirySlot` (layouts on the
[hashing page](https://blindseal.tech/docs/hashing)). Before hashing, the guest parses the payload — the
tool call — into the on-chain action it describes and asserts that action equals the one the proof binds
(target program, instruction, source authority, recipient, mint, amount; since 0.7.0): a payload that is
not an on-chain action, or that describes a different one, cannot be attested. `blindseal attest` applies
the same rule before it starts the prover. The guest then re-runs the committed L1 automata on the
payload; a proof cannot exist for a payload L1 flags.

On Solana, `blindseal-verify` (`6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`) is called by CPI from the
gated program (the example is `transfer-gate`, `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa`) in the same
transaction as the action. Its check order is documented in the header of
`programs/blindseal-verify/src/lib.rs`; in short:

- **Caller binding** — only the program the attestation was produced for can consume it, by direct CPI.
- **Not paused** — the verifier's config authority can pause it. That authority can be handed over with
  `set_authority`, which the current and the new authority must both sign.
- **Allowlists** — the verifying key must be accepted, and the policy root registered (approved policies
  are on by default since 0.7.0). The example gate additionally accepts only the policy roots it lists
  itself (`EXPECTED_POLICY_ROOTS`, the default root) and refuses any other with `UnexpectedPolicyRoot`;
  an integrator sets its own list.
- **Expiry** — `expirySlot` must not have passed.
- **Action binding** — the verifier recomputes `actionHash` from the fields the calling program is about to
  execute (program, instruction, source authority, recipient, mint, amount). A proof screened for one
  transfer cannot approve a different one.
- **One-time use** — the nullifier is a function of the action hash; a Nullifier account is created when the
  proof is consumed, so a second use fails (`NullifierAlreadyConsumed`). If the action fails, the whole
  transaction reverts and the proof can be retried.
- **Groth16 verification** of the proof against the public inputs.

The proof can also be checked off-chain with the WebAssembly verifier (`blindseal verify`, or the site's
verify page). That checks the proof only; expiry, allowlists and the nullifier are the on-chain program's job.

## The audit log

Every attested decision is appended to a local hash-chained audit log under `~/.blindseal`. Entries are
content-free by construction (ids, verdict, payload hash, the previous entry's hash); the decision content
lives in a separate encrypted store. Changing or removing an earlier entry breaks the chain, which
`blindseal audit verify` detects, and `blindseal audit disclose` produces a signed disclosure that proves a
window of entries is consistent without exposing traffic. The chain proves integrity and order, not that an
operator ran every call through the proxy.

## What is proven, and what is not

Proven (zero-knowledge, verifiable by anyone):

- The payload with this hash was screened by the detector with this verifying key, under the policy with
  this root, and the committed L1 rules found it clean.
- The screening is bound to one on-chain action, an expiry slot and a fresh nonce.
- On chain: the attestation was consumed once.

Attested, not proven:

- L2 and L3 verdicts. They run locally (L3 at the provider you configure) and are recorded, but their output
  is not inside the proof.
- The audit log's content.

Run but not proven yet:

- L0 (decode-then-L1). The proxy runs it; the proof covers L1 on the payload as received. L0 inside the proof
  is the next increment and will change the detector version.

Not covered:

- Traffic that does not pass through the proxy.
- Attacks the committed rules miss. The proven layer alone catches a minority of the published red-team
  corpus; detection in practice leans on L2/L3. The numbers are in `LIMITATIONS.md`.
- The correctness of the gated program beyond the fields it forwards.
- A compromised operator machine.

## Threats Blindseal does NOT defend against

Each item references the section of `LIMITATIONS.md` with details and red-team evidence.

1. **Multilingual injections.** L1 patterns and the L2 embedding model are English-only. — §1.
2. **Semantically novel social engineering** (authority framing, politeness escalation) without L3. — §2.
3. **Tiny paraphrased attacks buried in long benign prose.** Streaming chunks mitigate, not solve. — §3.
4. **SVG / YAML front-matter / TOML structural injections** that use no English trigger words. — §4.
5. **Judge-prompt manipulation of L3 itself.** — §5.
6. **"Ignore X" with an arbitrary noun** (e.g. "ignore the user's question"). — §6.
7. **Content classification** beyond prompt injection. Blindseal is not a content-safety filter. — §7.
8. **What the agent does once a malicious instruction reaches it.** Blindseal is not a sandbox. — §8.
9. **Adversarial paraphrasing** by an attacker who has read the public corpus. — §10.
10. **Injections removed by upstream normalization** (an MCP server that converts HTML to Markdown and
    strips comments before Blindseal sees the response). — §15.

## Assumptions

1. **The operator's machine is not compromised.** An attacker with code execution on the host can kill the
   proxy, swap the embedding model, read the L3 key, or rewrite local files.
2. **The L3 provider is trusted** for its verdicts when L3 is enabled. A local Ollama model keeps L3 on the
   machine.
3. **The L2 inputs are trusted.** The attack corpus and its embeddings ship in the npm package; the embedding
   model (`Xenova/bge-small-en-v1.5`) is downloaded from Hugging Face on first use and cached locally. The trust
   boundary is the npm install plus that one download.
4. **The program upgrade authority is trusted.** Both programs keep an upgrade authority, held today by a
   single key; whoever holds it can change what the verifier accepts. `solana-verify` checks that the
   deployed bytes match this repository.
5. **The gated program forwards its own action.** The action fields it passes to the verifier must come from
   the action it executes, never from the agent.

## What an attacker still has to do

To redirect an agent through a tool response while Blindseal runs in `block` mode, an attacker must do at
least one of the following:

- **Defeat L1 and L2 at once**: no L0/L1 trigger, and an embedding farther than the L2 threshold from every
  corpus entry (the bypass classes are `LIMITATIONS.md` §1–§6).
- **Also evade L3** where it is enabled.
- **Route around the proxy**, or **compromise the operator's machine**.
- **Get a malicious tool fingerprinted before first connect**, before manifest drift detection can fire.
- **Land the attack inside the upstream-normalization gap** (§15).

To get a gated Solana action approved, an attacker additionally needs a proof for that exact action under an
accepted verifying key and policy root, before it expires, that has not been used — which requires the
payload to pass the committed L1 rules on the operator's machine.

Blindseal raises the cost of a prompt-injection attack; it does not eliminate the attack class.
