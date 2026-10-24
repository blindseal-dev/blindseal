# Visual diff — shipped pages vs design/mockups (2026-10-23, after the faithful S02–S06 port)

1440×900, first screen, full motion settled (2.5 s), fonts ready, scrolled to top. Differing pixels
by `pixelmatch` (threshold 0.1). Live = https://blindseal.tech (site) and the dashboard served by the proxy.

| Pair | Differing pixels | Files |
|---|---|---|
| S01-home | 0.16% | `S01-home-mockup.png` · `S01-home-live.png` · `S01-home-diff.png` |
| S02-how-it-works | 0.00% | `S02-how-it-works-mockup.png` · `S02-how-it-works-live.png` · `S02-how-it-works-diff.png` |
| S03-verify | 0.21% | `S03-verify-mockup.png` · `S03-verify-live.png` · `S03-verify-diff.png` |
| S04-docs | 2.58% | `S04-docs-mockup.png` · `S04-docs-live.png` · `S04-docs-diff.png` |
| S05-explorer | 4.56% | `S05-explorer-mockup.png` · `S05-explorer-live.png` · `S05-explorer-diff.png` |
| S06-changelog | 1.53% | `S06-changelog-mockup.png` · `S06-changelog-live.png` · `S06-changelog-diff.png` |
| D01-decisions | 4.44% | `D01-decisions-mockup.png` · `D01-decisions-live.png` · `D01-decisions-diff.png` |

Expected, by construction: the mockups render synthetic fixtures (counts, hashes, timestamps) and the
live pages render the mock API's fixtures or mainnet data, so copy/number differences show as
pixels; the explorer differs most when it reads mainnet live. Structural differences (missing
sections, chrome, backgrounds) are what to read these for.

Before the S02–S06 port (pages were summaries with their own class names and none of the mockups'
page.css): S02 5.28 %, S03 2.46 %, S04 3.72 %, S05 6.66 %, S06 3.43 %. After: the frame, columns, type and
rhythm match; what remains is data (the explorer's fixture series vs one real mainnet consumption, the docs'
longer tree and text, four releases vs seven).
