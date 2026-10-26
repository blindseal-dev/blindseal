# Visual diff — shipped pages vs design/mockups (2026-10-24)

1440×900, first screen, full motion settled (2.5 s), fonts ready, scrolled to top. Differing pixels
by `pixelmatch` (threshold 0.1). Live = https://blindseal.tech (site) and the dashboard served by the proxy.

| Pair | Differing pixels | Files |
|---|---|---|
| S01-home | 3.63% | `S01-home-mockup.png` · `S01-home-live.png` · `S01-home-diff.png` |

Expected, by construction: the mockups render synthetic fixtures (counts, hashes, timestamps) and the
live pages render the mock API's fixtures or mainnet data, so copy/number differences show as
pixels; the explorer differs most when it reads mainnet live. Structural differences (missing
sections, chrome, backgrounds) are what to read these for.
