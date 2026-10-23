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
1. **Wire the real verifier**: `wasm-bindgen` `crates/verifier-wasm` → `@blindseal/verifier-wasm`, swap the
   isolated `verifier.ts` import on both verify pages (compile-to-wasm already proven).
2. **M2 on-chain**: Anchor verify program + transfer-gate + devnet deploy (budget ~230k CU + logic, per M0.5).
3. Raise dashboard motion fidelity (sliding pill, row flash) and the site CRT hero; add a §5 counts endpoint
   to unblock `/decisions` counts + `/policy` root preview.
