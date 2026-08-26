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

---

# Design QA — recommendation cards (2026-08-26)

**Comparison target**

- Source visual truth: `/Users/zver/.codex/generated_images/01a03d3f-0665-7a40-8864-dbdc2a1b6d9d/exec-7cf9ce4d-a124-4971-937c-831afd6bb2f6.png`
- Browser-rendered implementation: `http://127.0.0.1:5175/frame.html?width=375` and `?width=430`
- Implementation screenshots:
  - `/private/tmp/recommendation-card-qa/cards-area-375-exact.png`
  - `/private/tmp/recommendation-card-qa/cards-area-430-exact.png`
- Combined comparison: `/private/tmp/recommendation-card-qa/design-qa-comparison-cards.png`
- Viewports: 360, 375, 390, 412, and 430 CSS px; synthetic recommendation data; light theme; default state.
- Source pixels: 853 × 1844. Implementation evidence: 375 × 505 and 430 × 505. The focused comparison normalizes the source to 375 CSS px and crops both images to the same 375 × 505 content region. Browser density is 1 CSS px per captured pixel.

**Findings**

- No actionable P0/P1/P2 visual mismatch remains in the recommendation-card scope.
- [P3] Category fallback photography can still feel generated when the same event type repeats.
  Location: hero images in `RecommendationGridCard`.
  Evidence: the visual target uses event-specific photos, while the current recommendation API exposes no event image field. The implementation therefore uses one local fallback per event category.
  Impact: repeated cards of the same category may look templated even though the surrounding UI is restrained.
  Fix: keep the fallback for this frontend-only change; replace it with event-specific media only after an existing API contract exposes a safe image URL.
- [P3] Favorite control from the visual target is intentionally absent.
  Location: hero zone.
  Evidence: the existing recommendation item model and event actions expose no favorite state or favorite mutation; adding the heart would create fake behavior.
  Impact: this is a visible difference from the target, but preserves the real data and interaction boundary.
  Fix: none in this branch; add only with a proven existing event-favorite contract.

**Required fidelity surfaces**

- Fonts and typography: existing LK2 `RF Dewi`/`Inter Display` families are reused. Event titles remain the primary text and clamp at two lines; metadata truncates rather than shrinking below the compact LK2 scale.
- Spacing and layout rhythm: two-column measurements match the selected direction. At 375 px the grid is 12 / 171.5 / 8 / 171.5 / 12. At 430 px it is 16 / 193 / 12 / 193 / 16. Card heights are 248 and 256 px; hero heights are deliberately reduced to 72 and 76 px.
- Colors and visual tokens: white surfaces, a thin neutral border, existing purple action color, and semantic type text colors. No new card gradient, glow, shadow stack, pastel container, or recommendation pill.
- Image quality and asset fidelity: three category-specific WebP fallbacks are correctly cropped with `object-fit: cover`; no placeholder boxes, CSS drawings, emoji, inline SVG hero art, or stretched source imagery.
- Copy and content: real recommendation fields drive time, title, venue/court, level/trainer, availability, price, and CTA. Recommendation reason copy is intentionally removed per the final user direction.

**Focused region evidence**

- A focused card-region comparison was required because the full Home shell includes the existing LK2 hero/background and is not owned by this task.
- The combined 375 px crop shows image proportion, title wrapping, metadata density, availability, avatar stack, and CTA alignment at readable size.
- Browser DOM measurement confirmed zero horizontal overflow inside the card grid at all five requested widths. The existing clipped Home decorative layer is outside this component-level claim.

**Comparison history**

1. Initial browser pass found a P2 containment mismatch: auto-sized grid tracks were shorter than the fixed card body, clipping CTA content inside the recommendation wrapper.
2. Fixed by assigning responsive row heights that match the measured card composition: 244 px at 360, 248 px at 375–412, and 256 px at 430.
3. The same pass found that an activity host was being visually announced as a participant even though the contract exposes a host, not a participant roster. The host now remains in metadata and the participant stack is omitted for activities without roster data.
4. Post-fix browser evidence shows `scrollHeight <= card height`, aligned CTAs, and zero card-grid horizontal overflow at 360/375/390/412/430.

**Product Design audit: what still looks AI-generated?**

- No pill explosion, nested cards, arbitrary pastels, glass, glow, layered shadows, oversized radius, decorative icons, or gradient buttons remain.
- The only remaining AI-like signal is the repeated synthetic category photography described as P3 above; it is an explicit fallback for a missing contract field, not a production-data substitute.

**Open questions**

- Human visual review should confirm whether the 72/76 px hero is short enough on real devices and whether repeated category fallbacks are acceptable until event media exists.
- Full authenticated Home, loading/empty/error states, and live API data were not available in the local visual fixture; behavior checks use the focused component tests and synthetic recommendation page.

**Implementation checklist**

- [x] Remove recommendation badge/reason.
- [x] Reduce hero height.
- [x] Preserve existing details and CTA routes.
- [x] Avoid modifying the shared `GameCard`.
- [x] Verify 360/375/390/412/430 px without overflow.
- [x] Verify focused tests, lint, typecheck, and web build.

**Follow-up polish**

- Replace category fallback media with event-specific photos if and when the existing recommendation contract adds them.

final result: passed

---

# Follow-up QA — separate Home V3 route and title spacing (2026-08-26)

**Comparison target**

- Source visual truth: `/Users/zver/.codex/generated_images/01a03d3f-0665-7a40-8864-dbdc2a1b6d9d/exec-7cf9ce4d-a124-4971-937c-831afd6bb2f6.png` (853 × 1844 px).
- Browser-rendered implementation: `http://127.0.0.1:5175/frame.html?width=375` and `?width=430`.
- Implementation screenshots: `/private/tmp/recommendation-card-qa/v3-after-375.jpg` (375 × 940 px) and `/private/tmp/recommendation-card-qa/v3-after-430.jpg` (430 × 940 px).
- Focused same-input comparison: `/private/tmp/recommendation-card-qa/v3-focused-comparison-430.png` (860 × 350 px).
- State: synthetic recommendation page, light theme, initial card grid. Browser density is 1 CSS px per captured pixel.

**Findings**

- No actionable P0/P1/P2 mismatch remains.
- The reported title collision is resolved: every title reserves two 1.28-line-height rows and cannot shrink under the metadata block. Browser geometry reports a stable 7 px gap between title and metadata for every card.
- The photo remains deliberately short: 72 px through 412 px and 76 px at 430 px.
- The redesign is isolated to `/home-v3`. `/` retains the original Home and `/home-v2` retains Home V2.

**Required fidelity surfaces**

- Fonts and typography: `RF Dewi`/`Inter Display` remain unchanged. Titles clamp to two lines, use `line-height: 1.28`, and reserve `2.56em`; the following metadata never crosses the title box.
- Spacing and layout rhythm: 360/375/390/412/430 px were measured. Inner card widths are 162/169.5/176/187/191 px, card heights are 258/262/262/262/278 px, and grid gaps are 8/8/10/10/12 px. There is no card or grid overflow.
- Colors and visual tokens: no visual-token changes were introduced by this follow-up.
- Image quality and asset fidelity: existing WebP category fallbacks and crops are unchanged.
- Copy and content: the title, venue, level/trainer, availability, and CTA continue to use the existing recommendation model.

**Comparison history**

1. The previous fixed-height row allowed flex children to shrink, visually crowding the one-line `Открытая игра` title with the metadata below.
2. Fixed by reserving the full two-line title block, preventing title/metadata/social/CTA shrink, and allowing responsive grid rows to grow from a minimum instead of enforcing a smaller fixed height.
3. Post-fix evidence: `gap = 7`, `scrollHeight = clientHeight`, and no horizontal overflow at all five requested widths.
4. The new photo cards previously replaced the primary `/` route. The route mapping now keeps versions 1 and 2 unchanged and exposes the redesign only at `/home-v3`.

**Open questions**

- P3 remains unchanged: repeated category fallback photos may feel templated until the existing API exposes event-specific media.
- Full authenticated `/home-v3` data was not available in the synthetic fixture; route isolation is covered by App tests and card rendering by browser evidence.

**Implementation checklist**

- [x] Preserve `/` as Home V1.
- [x] Preserve `/home-v2` as Home V2.
- [x] Expose the photo-grid redesign at `/home-v3`.
- [x] Prevent title/metadata overlap.
- [x] Keep the reduced 72/76 px hero.
- [x] Verify 360/375/390/412/430 px without overflow.

final result: passed
