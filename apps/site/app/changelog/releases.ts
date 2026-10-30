// The release notes, newest first — rendered by page.tsx and read by the docs sidebar (the date of the
// release matching packages/proxy's version). Inline markup in a note: `code`, and {{id:<base58>}} /
// {{sig:<base58>}} for a program id / transaction signature (rendered as a copyable, truncated hash).
export const RELEASES: { v: string; date: string; added: string[]; changed: string[]; fixed: string[] }[] = [
  {
    v: '0.7.0', date: '2026-10-30',
    added: [
      'Screening covers every agent-visible surface: every server message and every string in it (structuredContent included), outbound tool-call arguments, and each element of a JSON-RPC batch on its own (HTTP, SSE, stdio). An id-less `tools/call` is screened and gated too; blocked, it is dropped',
      'Binary image and audio content is exempt from text screening only when it is a structurally valid file of the declared type: PNG, JPEG, GIF, WebP, BMP, ICO, TIFF; WAV, AIFF, MP3, AAC, FLAC, Ogg. AVIF/HEIC, MP4/M4A and WebM are not exempt in 0.7.0 and are screened as binary (LIMITATIONS §15)',
      'Redaction before the model layers: structured JSON by key (credential and personal-data keys, nested and in arrays, in JSON and in non-JSON text). Payload hashing and action binding keep the original',
      'Every proxy decision (capability allow/warn/block, detection, manifest, screening errors) goes to the content-free hash chain; content only to the encrypted store, redacted. scans.db holds no content',
      'The guest binds the screened payload to the action it attests. The proven Layer 0/1 equals the Rust guest; screening extras stay proxy-only',
      '`set_authority` on the verifier config (hand-over to a hardware wallet); approved policies are on by default',
      '`blindseal run` serves the live engine; `--mock` shows a Sample data banner. Startup prints the layer-2 and layer-3 status',
      'A staged mainnet release script with `--simulate` for every step and the typed confirmation inside the signing helper. CI gates for dependency audit and identity',
    ],
    changed: [
      'Programs upgraded on Solana mainnet from verifiable builds of commit 5cef6be: transfer-gate {{sig:4CP4dquvsbnC3Su8aAfRt6Hn3PFbHMqNTQT5Znq2sz9KFqJrSxw5PaAdcgjRnEG4rSg2atK9JSR4VaYaXbKZqqcS}}, then the verifier {{sig:3f97M7MKXmzu9qZvvPCj3tp59mLDDmVmTpLuj2KGmwWM1qSs8iYJ6BnKVG46ZiVK1tYzYugxUDeHWkYa8hMMkdXs}}. Both match the source with solana-verify, and their on-chain verification records now name that commit ({{sig:59sJKXPv2rS3xsLt3YKVgvTUyDskRVoYwJGthmDg4gEB997B4fmzB2Eo8CtgS6e7cobeXkC2hUpSE5XdxXY1KF4n}}, {{sig:5NYUMkmnamN3MrLqoTx8rTPeHckJeBvpZQVkfk9QLnc86TEhFqG9wu6KRVWjKQxFb1SC7ZbFtWzR4UbgtajEu8zm}})',
      'Verifier config: approved policies on ({{sig:2KyzaXuJG8ECvKaycCzgYG5ZV2svtaBVBwDVqMTkZZG5AyUGbDcf1nUGEg73v1nMxmFHfRvAQEzrfFCvJpgfYNQE}}); the 0.7.0 vkey `0x00cdf40c…9f2967` allowed ({{sig:JqLSrTT5R9mb3fBNyoiBh6SfHQDhKt6XBLwpR6rZwDBEDGgZRESwWpy6mccBPTVWC9cibWnvyMyf3KbVJUN8k34}}); the 0.6.0 vkey `0x006a0d1e…9331e` removed ({{sig:3dq3nyYygVu9GfWY2o1Jn1Wn7qQhWUhWfxDiiEASsE1iMPQuWSA1Xeu8se88YrgsNByDmZR3NsoCMWNJjfyaqang}}). A proof under the old vkey is rejected with `DisallowedVkey` ({{sig:5wNf1fr5aQw5MUqNwyLHndJR378kdrNN4V426WZtJG4T3Azn6S3oXtK9dGaiNtrMbhJdqikcucYuRRxrHUrjQUWC}})',
      'New sample proof from the demo wallet under the 0.7.0 vkey, consumed through transfer-gate ({{sig:2HrABCZYnaHk66gmg9yi3mB27t487mpF6HgZMgbQJcxBhTm2L7nr1P2BbHPd46gHQWAvscAuJCTTGHtQz5mCFj26}}); its replay was rejected ({{sig:5QZZyttkpnWoCPd7sAh2n2FJqo9hsfq74b67acJSZsT65qWptRExJmum3LNeajSXfZVZ2Gk1G3WMN6hs4fvaK4Rg}}). The file is tests/fixtures/attestation-mainnet-demo-0.7.0.json',
      'Prover 0.7.0 released for darwin-arm64 and linux-x64 from the same guest ELF; `blindseal attest` downloads it sha256-pinned',
      'Layer 0/1 skip nothing for length: bounded chunks and a per-message time budget; a decoy cannot hide a match; screening runs off the event loop',
      'Layer 3 runs only with an explicit `BLINDSEAL_LAYER3_PROVIDER`; the active judge is printed at startup',
      'Unreadable input and screening errors fail closed',
      '`attest` keeps the prover payload in a private temporary directory and refuses a transfer-gate call the gate could never consume',
      'Dependencies: Next 15.5.28, web3.js 1.98.4, react-router 6.30.6, Playwright 1.55.1',
      'Copy across the CLI, dashboard, site and README matches behaviour: what is checked, the redaction scope, what the audit holds',
    ],
    fixed: [
      'The redactor keeps an own `__proto__` key; capability warn/block lines no longer echo argument values',
      'The manifest cache migrates every legacy record when opened and holds no credentials',
      'The stdio proxy exits on SIGTERM/SIGINT; the layer-2-unavailable notice prints once per decision',
      'Five independent audit rounds on the media parsers (A817-R3): each bypass fixed, and the formats that kept producing new ones were withdrawn from the exemption',
    ],
  },
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
