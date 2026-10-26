# Security policy

Blindseal's on-chain programs — `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` (verifier) and
`9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa` (transfer-gate example) — carry a
[neodyme security.txt](https://github.com/neodyme-labs/solana-security-txt) that points here.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Email **blindseal@proton.me** (or open a private
GitHub security advisory on this repository). Include what is affected, how to reproduce it (payload,
config, environment) and any mitigation you suggest. We acknowledge within 72 hours and publish a fix
before details, with credit if you want it.

## Scope

In scope:
- The on-chain programs: proof verification, the §3.7 check order, nullifier (replay) protection, the
  policy-root and vkey allowlists, upgrade/pause authority handling.
- The SP1 guest and prover (`crates/`): anything that lets an attestation be produced for a call the
  committed policy would not pass, or that leaks the payload through the public inputs.
- The proxy and its local API: prompt-injection bypasses of L0/L1 in `block` mode, redaction failures
  (secrets or PII reaching L2/L3), audit-chain or disclosure forgery, dashboard token handling.
- The SDK and the wasm verifier: accepting an invalid attestation or disclosure.

Out of scope:
- Detection evasion in `warn` or `log` mode (those modes let traffic through by design), and evasion of
  L2/L3 — the model-based layers are attested, not proven, and are documented as best-effort.
- False positives (clean content blocked) — report those as ordinary issues.
- Attacks that require code execution on the proxy host already.

## Supported versions

The most recent release on npm and the programs currently deployed at the ids above.

## Known limitations

The zero-knowledge proof covers the deterministic layers (L0 and L1) only. That is the claim: a specific
call was screened under a committed policy by a specific detector version and the deterministic layers
passed. It is not a proof that an agent is safe.
