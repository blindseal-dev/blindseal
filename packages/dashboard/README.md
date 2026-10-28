# @blindseal/dashboard

The local dashboard, ported from the mockups in [`design/mockups/`](../../design/mockups/):

- **Stack:** Vite + React + TypeScript + Tailwind; TanStack Query + a native WebSocket against the
  proxy's local API. Builds to a static bundle at `packages/dashboard/dist`, served by the proxy.
- **Data contract:** the authoritative [`docs/FRONTEND-CONTRACT.md`](../../docs/FRONTEND-CONTRACT.md).
- **Carry-overs:** carry the token layer, motion
  grammar, hash component, verdict colours, the five-state rule and the never-write scan from
  `design/mockups/` verbatim; keep the mockup's drawn figures (no backend SVG).

## Live data

`blindseal run` serves this dashboard over the decisions recorded on the machine: the hash-chained audit
log plus the encrypted content store (decrypted locally), `~/.blindseal/policy.json` (shown read-only) and
the attestations `blindseal attest` wrote. An empty audit log is an empty list, never sample data.

```
pnpm -C packages/proxy dev run --port 4831
# open with the token the proxy prints:  #token=<token>
```

## Mock mode (sample data)

For UI work and demos, `--mock` serves the same API contract from `fixtures/`; every page then shows a
"Sample data" banner:

```
pnpm -C packages/proxy dev run --mock --port 4831
```

- Endpoints + WebSocket `/events` match `docs/FRONTEND-CONTRACT.md`.
- **State switches** for every UI state: `BLINDSEAL_MOCK_STATE=<state>` or `?state=<state>` —
  `empty, unauthorized, offline, reconnecting, prover-down, chain-broken, tee, upstream-down`
  (the mockups' `?state=` set; `no-action, not-found, loading` are data/UI-side).
- Fixtures mirror the real engine: 22 committed L1 rules, real policy root `0x36a9e9…`, attestation
  public inputs in guest-commit order, `sourceAuthority` on actions.

The off-chain verifier the verify page needs is `crates/verifier-wasm` (confirmed to compile to
`wasm32`; wasm-bindgen packaging as `blindseal-verifier-wasm` is the remaining backend hand-off).
