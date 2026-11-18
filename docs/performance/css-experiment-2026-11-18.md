# CSS deferral experiment — measured and reverted (2026-11-18)

Decision: **revert**. The experiment reduced the build's eager stylesheet but not the CSS bytes or the
time in the measured first-screen window, so it added cascade risk without a demonstrated gain.

## Starting point

`apps/web/src/main.tsx` imports one `styles.css` (236,173 B raw / 41,677 B gzip). First-screen coverage
measured on the repaired stand was low:

| Screen  | Used CSS | Eager CSS | Used share |
| ------- | -------- | --------- | ---------- |
| Home    | ~16.0 KB | ~250.7 KB | 6.4%       |
| Profile | ~25.2 KB | ~255.8 KB | 9.9%       |
| Games   | ~16.0 KB | ~239.8 KB | 6.7%       |

Coverage is a symptom, not a plan: `styles.css` is 15,445 lines and its blocks are not owned by one
screen each. Selector ownership was audited before moving anything.

## Minimal change

Three blocks whose classes are not referenced by the first-screen modules were moved into
`apps/web/src/styles-lazy-screens.css` (48,234 B): tournament detail (11,224 B), gift certificates
(20,677 B, only the generic `is-selected` state selector is shared) and profile (16,035 B, only
`ProfilePage.tsx` owns those classes). The new stylesheet was imported by the six lazy screens that
own those styles.

Build result: eager CSS 236,173 → **197,790 B raw** (41,677 → **34,876 B gzip**), total critical
transfer gzip 193,396 → 186,610 B.

## Measured effect (7 alternating valid runs each, same conditions as the client report)

Reference = #678 without the CSS change (the same source with the stylesheet restored and the lazy
stylesheet empty). Candidate = #678 with the CSS change.

| Scenario     | displayed (reference → CSS)                    | data applied | CSS transfer, first window | total network             |
| ------------ | ---------------------------------------------- | ------------ | -------------------------- | ------------------------- |
| Home         | 3260 [2760..3994] → 3293 [3104..4223] (+33 ms) | 2610 → 2485  | 47,132 → **48,353 B**      | 310,154 → 311,371 (+0.4%) |
| Profile      | 6025 [5985..6280] → 5970 [5742..6049] (-55 ms) | 5150 → 5066  | 50,447 → 51,668 B          | 302,889 → 304,105         |
| Games        | 4604 [4312..4751] → 4538 [4425..4803] (-66 ms) | 4552 → 4494  | 47,132 → 48,353 B          | 308,706 → 309,923         |
| Home → Games | 2794 [729..3065] → 2825 [1114..3126] (+31 ms)  | 2752 → 2774  | 0 → 0                      | 3055 → 3055               |

All 56 runs were valid (14 per variant/scenario).

### Why the bytes did not move

The moved stylesheet is **still requested in the first-screen window**: the Home run loads
`styles-lazy-screens-*.css` (8,401 B transfer) in both builds. The reference build also loaded the
file (301 B, with its content emptied for the comparison), which shows the file is reachable from the
eager module graph — Vite places a stylesheet imported by several chunks into a shared asset that the
entry loads. Deferring it for real needs a per-screen CSS ownership split (including the shared
`GameCard`/`HomeDashboardPage` sheets), not a move of shared blocks.

Time deltas are inside the run-to-run spread (±1-2%); no scenario improved.

## Visual evidence

Screenshots at 390 px and 1280 px, Home / Games / Profile / Gift certificates / Tournaments, both
builds: [screenshots/css-experiment-20261118](screenshots/css-experiment-20261118). The rendered layout is
identical where data renders (Home, Games, Profile). The gift page shows the stub's "catalog
unavailable" state in both builds, so gift-specific styling was **not** exercised visually — that block
was moved on selector-ownership evidence only.

Final-build screenshots against the baseline build:
[screenshots/final-20261118](screenshots/final-20261118) (same 20 pairs, after the revert).

## Decision and next step

Reverted: the block move did not reach the browser window, added a second stylesheet with a cascade
order that depends on chunk loading, and produced no measured time gain. The final build ships the
previous single stylesheet.

If CSS is pursued later, the acceptance test must be a **per-screen ownership split** with an
automated check that no lazy-screen stylesheet is requested before the first screen, and the same
stand must show either fewer first-window bytes or earlier data; otherwise the split should not
merge.
