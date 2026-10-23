# Overnight sprint report — FE port + M0.5 (2026-10-22)

## Pages done (commit per page)
| # | Page | SHA |
|---|------|-----|
| prep | FE mockups → `design/mockups/`, scrub/Geist/sourceAuthority | d59cf33 |
| prep | mock API state switches (`BLINDSEAL_MOCK_STATE`/`?state=`) | b6b7740 |
| 1 | Shell + `/decisions` | f6e0cbd |
| 2 | `/decisions/:id` | a61f203 |
| 2 | `/audit` | b0eed50 |
| 2 | `/policy` | a80f73d |
| 3 | `/attestations` (side sheet) | beafebb |
| 3 | `/settings` | 6311e58 |
| 3 | verify page (isolated verifier) | f33222a |
| 4 | `apps/site` scaffold + S01 home | 1d36afd |
| 4 | S03 verify | 321af5a |
| 4 | S02 how-it-works | 54f56cc |
| 4 | S04 docs + API reference | 6b451ad |
| 4 | S05 explorer | a6d45c4 |
| 4 | S06 changelog | 96c7de7 |
| 5 | M0.5 localnet verify (real CU) | 57b3c0e |

All green at every commit (tsc + build + Playwright per page). Groups 1–4 complete; M0.5 closed.

## wip / deferred
None left `wip:`. Deferred-with-divergence (logged in DECISIONS/BLOCKERS, behaviour parity kept):
- Dashboard: sliding-pill nav (static pill instead), inter-page route cover, per-row enter/flash motion.
- `/policy`: full rule add/edit/delete + pending-root preview — the real root is a DFA-byte Merkle,
  not browser-computable; §5 has no count/root-preview endpoint. Enable-toggle + Save (server root) work.
- `/decisions`: free-text UTC from/to + per-server tool dropdown (range tabs + server filter work);
  counts computed client-side from a `limit=200` fetch (no §5 count endpoint).
- Site: WebGL CRT hero → nebula fallback.
- Verify pages: mock verifier (bit-for-bit vs the canonical sample); isolated for the wasm swap.

## DECISIONS added tonight
FE port architecture (hand-port TSX, kit CSS verbatim, drop Tailwind); page-1 divergence list;
`/policy` constraints; M0.5 localnet (227,375 CU) + the `build-sbf` from `program/` caveat.

## BLOCKERS (assumed answer, built on it)
1. `/decisions` tool-filter catalogue + a counts endpoint — assumed range-tab + client-side counts suffice.
2. `/policy` pending-root preview + rule-pattern CRUD — assumed enable-toggle + server-recomputed root suffice.

## Tests
- Dashboard: vitest 6/6 (gates + 3 state renders); Playwright 10/10 (one+ per page, each asserts zero-egress).
- Site: Playwright 8/8 (6 routes render + never-write + zero-egress; reduced-motion end state; verify sample/tampered).
- M0.5: on-chain VERIFIED on localnet + tampered rejected; **227,375 CU**, tx 584 B (`m05-localnet-metrics.json`).

## First thing tomorrow
1. ~~Wire the real verifier~~ **DONE 2026-10-23**: `@blindseal/verifier-wasm` (wasm-bindgen) runs the
   real Groth16 check in both verify pages; mock verifier removed. (The earlier "compile-to-wasm proven"
   was wrong — the 295 B module was empty; the real module is 406 KB and both links and runs.) Also:
   `splitPublicInputs` decodes the real len-1 commitment into the six display fields (unit-tested);
   verifier fails closed + retryable on a wasm load error. **Open follow-up:** no proxy route serves
   the React `dist/` yet (the current proxy dashboard is the legacy scan-history page). When one is added,
   it must serve `.wasm` as `application/wasm` and allow `wasm-unsafe-eval` if it sets a CSP — the e2e
   here runs against Vite dev, not that path. (See DECISIONS 2026-10-23.)
2. **M2 on-chain**: Anchor verify program + transfer-gate + mainnet deploy (budget ~230k CU + logic, per M0.5).
3. Raise dashboard motion fidelity (sliding pill, row flash) and the site CRT hero; add a §5 counts endpoint
   to unblock `/decisions` counts + `/policy` root preview.

---

# Finish sequence — M2 + M3 (2026-10-23, in progress)

## Done
| Item | Where |
|---|---|
| Mainnet-only chain model (chainId 1; 2 reserved; devnet removed everywhere) | `104dda7` |
| Prover CLI (binds real action fields; writes action/nonce/chainId/decisionId) | `104dda7` |
| `@blindseal/sdk`: buildVerifyIx / buildGatedTransferIx / submit (genesis guard) / verifyOffchain / admin ix | `104dda7`, later |
| `blindseal attest` (screen → audit → prove), `submit`, `verify`, `audit verify|disclose` | `104dda7`, M3 commit |
| `blindseal-verify` + `transfer-gate` Anchor programs, built to SBF (`scripts/build-programs.sh`) | `41a0ab4` |
| `tests/m2.spec.ts` — every §3.7 case incl. paused + atomicity — **15/15 green on localnet** | `441b3f6` |
| Proxy serves the built dashboard: `application/wasm` + CSP `wasm-unsafe-eval` (served.spec) | M3 commit |
| On-chain reads server-side: `/api/nullifiers/:nf`, site `/explorer` live via `BLINDSEAL_RPC_URL` | M3 commit |
| Disclosures end to end: CLI, API (real ed25519 in the mock), dashboard export, both verify pages accept `disclosure.json` | M3 commit |
| Docs: quickstart, concepts, hashing (§3.3 verbatim), gated-program guide, honest scope; changelog 0.5.0 | M3 commit |
| Identity sweep script + base-project names scrubbed from every surface | M3 commit |
| Mainnet tooling: `scripts/mainnet-deploy.sh`, `mainnet-init.mts`, `mainnet-acceptance.mts` | M3 commit |

## Pending (in order)
1. ~~Test proof → suite → numbers~~ **DONE** `441b3f6`: 15/15 on localnet; gated transfer **262,507 CU**, tx **893 B** (`docs/performance.md`).
2. ~~Mainnet proof~~ **DONE**: `blindseal attest` screened `tests/fixtures/mainnet-toolcall.json` with the real layers (clean), appended decision `d_ff1be0d3f891beef` to the hash-chained audit log (entry #0, chain INTACT), and proved it in 2 h 02 m → `tests/fixtures/attestation-mainnet.json` (VALID natively; binds authority `88sR7X…` → `6HwAr9…`, 0.001 SOL via transfer-gate, nullifier `0xfea1d3ec…`).
3. ~~Owner gate~~ **DONE 2026-10-23 13:28 PDT**: funded 3.995 SOL → `scripts/mainnet-deploy.sh` deployed both
   programs (upgrade authority = `88sR7X…`), initialized Config, registered the default root →
   `scripts/mainnet-acceptance.mts` consumed the real attestation through the gate and the replay was rejected.
4. ~~Quickstart on a fresh clone~~ **DONE**; site **live** at https://dv8pdxqyec.us-east-1.awsapprunner.com (App Runner, container image, `scripts/deploy-site.sh`).

## Mainnet signatures (Solana mainnet-beta, 2026-10-23)
| Step | Signature / id |
|---|---|
| `blindseal-verify` deployed (328,264 B, slot 460578969) | program `merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb` · deploy tx `5792KrcnK6cQNvQcpMwYfwBnANeEeuUu9wSR54mxTZfvkduba1unLGTGWwCqjPj4djyejZ9xbsWP2aAnsGctW7kP` |
| `transfer-gate` deployed (169,816 B, slot 460579053) | program `ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG` · `23LjzgpHhW61thoQjWiLhKdsKW5AixsA1ma1J24eK5MFhhgPLcCXdPEahEBQWw1p4Lx7VQrHW8AQAEkJS7nX39jS` |
| `initialize` (allowed_vkeys=[0x006a0d1e…331e], allowlist_policies=false, paused=false) | `uwY37Y8uTha1smFkvGykjs4JEiVJWmnp47y151PpH5HvfquutRKipywLCDwFWfayBzTedzsBKKqiHuU3M2uiLzq` |
| `register_policy_root` (0x36a9e945…8397) | `5y2dTDj534wbrkVAmSGSpkrFwJY9SLsPrwTGsdBRmRHSnLhYXcXfYVqBQsfjLaEF4DcXUFBi3u8czGfBvMJYnCV9` |
| **gated transfer — verify + consume + 0.001 SOL** (decision `d_ff1be0d3f891beef`, nullifier `0xfea1d3ec…15f1`), 259,324 CU, 893 B | **`7iwA4nxnBG73o8H8j8XUESYsmyGhGrxU5HiqXww8Nzp1YRC9oa7oE2ArWsd2fZN736vyhMatECyd2zw5agedpye`** |
| **replay of the same attestation — rejected** (`NullifierAlreadyConsumed`, custom error 6006, in the tx logs) | **`42QVDVFjBN7Sp9dpkgfUcKSeZZq67ji4hGRvtuJMJyA3jbxFT6GuJwQaWKSj3oTZoX9jgQjWhmN3iCU2L5w87y3E`** |

Authority after: 1.4536 SOL. Site live: https://dv8pdxqyec.us-east-1.awsapprunner.com (explorer reads these accounts live).

---

# Kit mounted at the root — measured on the deployed site (2026-10-23)

Diagnosis (yours) confirmed: the kit loaded but nothing mounted it after hydration. Fixed once, at
the root: `KitProvider` (site) runs the mockups' mount sequence after hydration and on every route
change; `BS.mountShell` (dashboard) replaces the hand-written frame; `site.js` + `crt.js` + `shell.js`
are loaded; the notch nav is `BS.mountSite`'s exact markup (wings, row, pill); the hero is the CRT
field with the reduced-motion still frame and the nebula fallback; "Open dashboard" opens
`http://127.0.0.1:7777` in a new tab. The kit is one ordered bundle loaded after hydration (the
modules boot on DOMContentLoaded and were racing React's hydration — #418/#423).

**The four numbers, Playwright on https://dv8pdxqyec.us-east-1.awsapprunner.com (not dev), image `b719620`:**

| Check | Result |
|---|---|
| `.reveal` elements still at opacity 0 after scrolling to the bottom | **0** on every route (`/`, `/how-it-works`, `/verify`, `/docs`, `/docs/hashing`, `/explorer`, `/changelog`) |
| `.site-notch` computed position / glass | **fixed**; backdrop-filter **none** — by design: the mockups mount `nav:"notch"` (opaque tabs on the 8px frame); backdrop-filter exists only in the `nav:"glass"` variant (`.site-notch--glass .notch.glass-bar`). Wings 4, pill present, 5 items. Say the word and it flips to glass. |
| Hero canvas with a WebGL2 context | **true** (CRT field running; headless Chromium too) |
| Console errors across the routes | **0** |

Also asserted: the footer is rendered on every route; "Open dashboard" href `http://127.0.0.1:7777`, `target=_blank`.
Suites: site 12/12, dashboard 11/11 (the shell adopts `<main id="main-content">`, which is React's root
container so event delegation survives). Visual diffs vs `design/mockups`: `docs/visual-diff/` (table below).

## Visual diff vs `design/mockups` (1440×900 first screen, full motion settled) — `docs/visual-diff/`
| Pair | Differing pixels | Reading of the diff image |
|---|---|---|
| S01 home | 0.16% | identical bar the hero's CRT noise frame |
| S02 how-it-works | 5.28% | chrome identical; long-form body copy/figures differ in wrap and fixture values |
| S03 verify | 2.46% | chrome identical; the live page carries the "Load disclosure" control the mockup predates |
| S04 docs | 3.72% | chrome identical; the live docs open on the quickstart (mockup: the API shell) |
| S05 explorer | 6.66% | chrome identical; **structural**: the mockup's four-tile + 30-day-chart explorer vs the shipped three-stat layout, and live mainnet counts vs fixtures |
| S06 changelog | 3.43% | chrome identical; the 0.5.0 entry the mockup predates |
| D01 decisions | 4.44% | shell (sidebar/pill/top bar/status bar) identical; fixture rows vs the mock API's rows, odometer frame |

Candidates for a faithful port, in order of pixel distance: S05 explorer, S02 how-it-works, S04 docs.
