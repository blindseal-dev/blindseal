# BLOCKERS — questions only the owner can settle (overnight sprint)

Each entry: the question, the assumption I built on, where it lives. Build continues on the assumption.

_(none yet)_

## /decisions
- **Q: tool filter list + free-text UTC time inputs** — §5 exposes `tool`/`from`/`to` query params
  but no tool catalogue endpoint. Assumption: range-tab time filtering + server filter are enough
  for v1; tool dropdown and free-text datetime are deferred. Built on that.
- **Q: counts over the full set** — §5 `/decisions` paginates (≤200 here) with no count endpoint.
  Assumption: fetch `limit=200` and count client-side (fine at fixture scale). A `/decisions/counts`
  route would be needed at real volume.

## /policy
- **Q: pending-root preview + full rule CRUD** — the real policy root is a Merkle over serialized
  regex-automata DFA bytes, so the browser cannot preview a root for edited rules, and editing a
  rule's pattern can't be reflected without the engine. §5 `PUT /policy` returns the recomputed root.
  Assumption: v1 supports enable/disable toggles (meaningful, server recomputes the root on Save);
  pending-root preview and add/edit/delete of rule patterns are deferred. Built on that.

## Mainnet deploy (M2) — needs funding
- **Deploy / upgrade-authority keypair:** `~/.blindseal/mainnet-authority.json` (not committed, mode 600)
  **pubkey `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj`** — fund this. It is also the
  `sourceAuthority` the mainnet attestation binds (it signs the gated transfer).
  Budget: program deploy rent for two programs (~2–3 SOL for the verifier, which embeds the
  Groth16 VK; ~1 SOL for transfer-gate) + Config/PolicyRoot/Nullifier PDAs + fees. Suggest **4 SOL**.
- **Mainnet recipient keypair:** `~/.blindseal/mainnet-recipient.json`, pubkey
  `6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo` (receives the 0.001 SOL gated transfer).
- **RPC:** `BLINDSEAL_RPC_URL` unset → public `https://api.mainnet-beta.solana.com` (rate-limited; logged).
- Program IDs are fixed now and shared by localnet and mainnet (keypairs committed under
  `keys/localnet/`, see DECISIONS): verify `merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb`,
  transfer-gate `ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG`.
