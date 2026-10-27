// The release notes, newest first — rendered by page.tsx and read by the docs sidebar (the date of the
// release matching packages/proxy's version). Inline markup in a note: `code`, and {{id:<base58>}} /
// {{sig:<base58>}} for a program id / transaction signature (rendered as a copyable, truncated hash).
export const RELEASES: { v: string; date: string; added: string[]; changed: string[]; fixed: string[] }[] = [
  {
    v: '0.6.0', date: '2026-10-27',
    added: ['`blindseal submit --wallet <source keypair>` sends the gated transfer through transfer-gate; the SDK’s `submit()` does the same and `decodeNullifier` reads a nullifier record'],
    changed: [
      'The verifier only accepts a call from the attestation’s target program, one level deep (instructions sysvar + stack height): a direct call fails with `DirectCallNotAllowed`, any other caller with `CallerNotTargetProgram`. The nullifier records that program as the consumer. This also stops anyone who copies a submitted proof from consuming it before the real transaction lands. Programs upgraded on Solana mainnet: transfer-gate {{sig:2HZ68TJpVvj3oS6td2iRhErGrjVPSt42ftum2Qq5Xnp1jU9NBUqpXMNDaqmC3znUvoMzrEdVHjpv2kctg2RW8bes}}, then the verifier {{sig:3mwn7MYCNH7AA5tz7N4Pp77oygN1aQrZcG42zgeS6TLjHd17gUbY5b7FXqgva4kRN3yFmtugpvcVZeEcw7sCC2Ha}}; both re-verified against the source with solana-verify',
      'security.txt in both programs points at blindseal.tech',
      'The sample proof is a new one from a separate demo wallet, consumed through transfer-gate on mainnet ({{sig:4hZUeGx4jAEAGMXwVqoLZmf6BUD3vFYtP1yjfm3vhDGFF8hfTTZCznCnayihErpaG2BgykL2f45sC1HKBChnTTpS}}); its replay was rejected ({{sig:5XcMWnxBnG3YsDMU4dFGYmCWfeXcWzNm2PUaLqE1dQoGEhmdGzFF3XX4XQWa7Xpn2CSS71GsxWxybzYyw6HMAbV5}})',
      'The previous verifier {{id:merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb}} and transfer-gate {{id:ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG}} are closed; their past transactions stay on chain',
    ],
    fixed: ['A record consumed by a direct call before this release shows as a direct submission, not as program 1111…'],
  },
  { v: '0.5.4', date: '2026-10-27', added: ['The dashboard ships inside the blindseal npm package and `blindseal run` serves it; `blindseal dashboard` opens it'], changed: ['Wording across the CLI, dashboard and site: model-based checks run locally and are attested, not proven; a TEE mode is planned'], fixed: [] },
  { v: '0.5.3', date: '2026-10-26', added: ['`attest` warns when the last proof on this machine took more than half the expiry window'], changed: ['`attest --expiry` defaults to the current slot + 40,000 (about 4.4 hours); `--expiry` overrides, `--no-expiry` is opt-in'], fixed: [] },
  {
    v: '0.5.2', date: '2026-10-26',
    added: ['The linux-x64 prover binary on the GitHub release, sha256-pinned in the CLI'],
    changed: [
      'New program ids: verifier {{id:6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx}}, transfer-gate {{id:9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa}}; the previous verifier is paused',
      'Redeploy on Solana mainnet: the new verifier’s config initialised ({{sig:hEU62NbpXu6dW6PDxk3gF4SV9PVED2F17noZHrGsotNuGEy67zAg21mtBZgoTh2Ax37QFFHonQ76ydvPAkLta1R}}) and the default policy root registered ({{sig:2R8XFgeZfbv5iTLwQZTb53GvnELj6oevEZrWq9stxckkY46kAo9FwFQQEQWYy9Gc5R6ZkQnUaVthXfFjVz7DXsxQ}}); the new transfer-gate deployed ({{sig:4QhM8bw9m8EASTrR1FkFjpm68eyCCj4tydxEDrTTSy9kyBCuMzaGMfmHZ9KC5e6m6GGiLVqSWpmhPswTLdpcRaGt}})',
      'The previous verifier {{id:merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb}} is paused ({{sig:3R5zbz9dm2VPYwgEffqqBpenM8ZASd916cdXqc8ibDu1AmHuUUqC4qR3mXTwcFFYqFQoQVSAMV3EArQ5FTA3mm4J}}). The previous transfer-gate {{id:ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG}} has no pause flag; it is inert, because it can only consume an attestation through the paused verifier',
    ],
    fixed: [],
  },
  { v: '0.5.1', date: '2026-10-26', added: ['`blindseal init` sets up ~/.blindseal (identity key, default policy, dashboard token); `init --wrap` routes your MCP configs through blindseal', 'The prover binary downloads on first `attest` from the GitHub release, sha256-pinned'], changed: ['Unknown commands exit with an error; wrapping a server needs `--`', 'Telemetry removed'], fixed: ['`verify` decodes the public data and fails when any labelled field differs from it'] },
  { v: '0.5.0', date: '2026-10-23', added: ['On-chain verifier program (blindseal-verify) and the transfer-gate example: Groth16 verify via sp1-solana, nullifier set, vkey and policy-root allowlists, paused flag', 'SDK: buildVerifyIx, submit (mainnet-only, genesis-hash guarded), verifyOffchain', 'CLI: blindseal attest (screen → audit → prove) and blindseal submit', 'The proxy serves the built dashboard with application/wasm and a CSP that allows the in-browser verifier', 'Mainnet explorer and on-chain nullifier status, read server-side'], changed: ['Solana mainnet is the only deploy target; chainId 2 is reserved (devnet removed everywhere)', 'The verify pages run the real Groth16 verifier compiled to WebAssembly; the mock verifier is gone', 'Attestations carry the action fields and nonce the on-chain recompute needs'], fixed: ['Attestation detail decodes the single committed public-input blob into its six fields'] },
  { v: '0.4.0', date: '2026-10-22', added: ['Local dashboard (decisions, audit, policy, attestations, settings)', 'Verify page with the in-browser verifier'], changed: ['Policy root is now a Merkle over the committed rule DFAs'], fixed: ['HTML-entity decoder no longer fails open on oversized entities'] },
  { v: '0.3.0', date: '2026-10-10', added: ['Off-chain Groth16 verifier (sp1-verifier)', 'Hash-chained audit log with selective disclosure'], changed: ['Detector version is the SP1 vkey'], fixed: [] },
  { v: '0.2.0', date: '2026-09-20', added: ['SP1 guest: payloadHash + policyRoot commitment', 'Redaction before L2/L3'], changed: [], fixed: [] },
];
