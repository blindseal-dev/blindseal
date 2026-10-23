# @blindseal/dashboard

The local dashboard (FRONTEND.md §3): **Vite + React + TypeScript**, built to a static bundle at
`dist/` that the proxy serves. No SSR, no external requests. Data comes from the proxy local API
(mock mode: `mock-server.ts`) over the §5 contract, with a `/events` WebSocket for the live stream.

## Run

```
# terminal 1 — the mock API on :4831
BLINDSEAL_MOCK=1 pnpm -C packages/proxy dev run --mock --port 4831
# terminal 2 — the dashboard dev server on :5319 (proxies /api + /events to :4831)
pnpm -C packages/dashboard dev
```

Open `http://localhost:5319/#token=<token printed by the proxy>`. In production the proxy serves
`dist/` and injects the token into the fragment.

```
pnpm -C packages/dashboard build      # tsc + vite build -> dist/ (≈69 kB gz)
pnpm -C packages/dashboard test       # vitest: acceptance scans + component tests
```

## Layout

- `src/tokens.css` — the design token layer, ported verbatim from `frontend-reference/` (dark only;
  shadcn aliases included). `src/index.css` is the component layer; no colour literal lives outside
  the tokens.
- `src/api/` — `types.ts` (the contract, see `docs/FRONTEND-CONTRACT.md`), `client.ts` (fetch +
  in-memory bearer token from the URL fragment), `hooks.ts` (TanStack Query + the `/events` socket
  folded into the query cache).
- `src/components/` — `Shell` (sidebar + top bar with the connection pill + MOCK chip + the audit/
  policy/detector/L3 status bar), `Hash` (click-to-copy truncated hash), `VerdictChip`, `LayerStrip`.
- `src/pages/` — `Decisions` + `DecisionDetail` are wired to live data. `Audit`, `Policy`,
  `Attestations`, `Settings` are `Stub`s — the shell, routing, tokens and data layer are in place;
  each is a mechanical port of its mockup in `frontend-reference/mockups/D0x/` against `api/hooks.ts`.

## Component inventory (status)

| Page | Route | Status |
|------|-------|--------|
| Decisions | `/decisions` | **wired** — live table, verdict filter, counts, row → detail |
| Decision detail | `/decisions/:id` | **wired** — layer breakdown, hashes, action |
| Audit | `/audit` | stub |
| Policy | `/policy` | stub (note: the Merkle root must come from `PUT /policy`, not JS) |
| Attestations | `/attestations` | stub |
| Settings | `/settings` | stub |

The marketing site (`apps/site`, Next.js) is a separate package, not yet scaffolded.
