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
