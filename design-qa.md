# Home V3 design QA

## Evidence

- Source visual truth: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-source.png`
- Implementation: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-after.png`
- Route and state: authenticated `/home-v3`, `Для меня`, recommendation sheet at its initial scroll position.
- Browser viewport: 1420 × 1200 CSS px; app frame: 375 CSS px; `devicePixelRatio: 1`.
- Source pixels: 1420 × 1200. Implementation pixels: 1420 × 1200. No density normalization was required.
- The rotating promotion can show a different campaign between captures; it was excluded from the card-focused judgment because the requested change is limited to the recommendation sheet.
- Both images were opened together in one comparison input. The full view was sufficient because the implementation capture preserves the recommendation sheet at native 1:1 density; small UI details were additionally checked from the rendered DOM and computed styles.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Fonts and typography: existing RF Dewi and Inter Display hierarchy, weights, wrapping, and compact metadata scale remain unchanged.
- Spacing and layout rhythm: the sheet keeps two equal columns, 10 px gaps, 18 px card radii, protruding mini-create controls, and no horizontal overflow (`scrollWidth = clientWidth = 359`).
- Colors and tokens: existing training, tournament, rating, surface, border, and purple action tokens are preserved.
- Image quality and assets: existing promotion, community, avatar, and icon assets are reused. Activity host avatars use the shared project avatar component and open slots use the shared slot asset.
- Copy and content: date metadata and court names are absent from V3 rows; station and time share one row. Game lifecycle status text is absent when the static plus is shown. Accessible action names remain available.

## Interaction and runtime evidence

- Initial V3 page rendered 14 cards: 7 activities and 7 games.
- Scrolling appended 12 cards, changing the rendered count from 14 to 26 without an error; a second scroll changed it from 26 to 38.
- Every initial card had a mini-create control. All 7 game controls used the static variant.
- All game progress rings computed to `display: none`; level badges remained in the accessibility tree.
- All 7 activity cards showed a host avatar. Visible open-slot counts were `3, 3, 1, 3, 1, 2, 1`.
- V2 regression check rendered one column and 6 cards, retained text actions, date/court metadata, and visible progress rings, with no mini-create controls.
- Browser console errors checked: none.

## Comparison history

1. Pagination continuation initially failed when the optional upstream activity read changed between requests.
   - Fix: cache the assembled, version-bound feed for its five-minute delivery window.
   - Post-fix evidence: 14 → 26 → 38 cards with no alert.
2. Building the complete feed in one chronological pass displaced games from the first page.
   - Fix: preserve relevance and diversity in the first-page batch, then rank each 12-item continuation batch.
   - Post-fix evidence: the first page contains 7 activities and 7 games, including a tournament.
3. Live slot counts were absent because the current provider payload uses `maxClientsCount`.
   - Fix: normalize `maxClientsCount` before legacy capacity aliases.
   - Post-fix evidence: host avatars and shared open-slot shapes render on all visible activity cards.

## Follow-up polish

- P3: when PadlHub-owned trainer or organizer media becomes available, replace initials fallbacks with the delivered local avatar URL; provider photo URLs must remain private.

## Implementation checklist

- [x] Two-column V3 card sheet retained.
- [x] Activity host and shared free-slot avatars rendered.
- [x] Game avatar rings removed while level badges remain.
- [x] Static game plus replaces status text.
- [x] First 14 and subsequent 12-item pages verified.
- [x] V2 regression verified.

final result: passed
