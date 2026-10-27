# Mobile screenshots — 2026-10-27

`<engine>-<width>-<route>.jpg`: Chromium and WebKit at 360, 390 and 430 CSS px, every route. These are the first
two screens of each page, kept small so the repository stays light. The full-length captures (PNG, 60 files) are
attached to the GitHub release `visual-diff-mobile-2026-10-27`.

Acceptance (`apps/site/e2e/mobile.spec.ts`, `playwright.mobile.config.ts`): 130/130 — no horizontal overflow, header
≤ 56 px, nothing visible beside or behind the header while scrolling, no rendered text under 12 px (SVG text measured
with its scale factor), every tap target ≥ 44 px, zero console errors.
