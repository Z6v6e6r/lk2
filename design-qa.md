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

---

# Follow-up QA — laconic Home V3 card body (2026-08-26)

**Comparison target**

- Source visual truth: `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-c70ecec0-78fa-4dbc-9bbd-fa5d4124dfb7.jpg` (1280 × 853 px), with the annotated card direction additionally supplied in the browser comment.
- Focused source crop: `/private/tmp/recommendation-card-qa/laconic-reference-card.jpg` (270 × 300 px).
- Browser-rendered implementation: `http://127.0.0.1:5175/home-v3`, local synthetic recommendation state.
- Full implementation screenshots: `/private/tmp/recommendation-card-qa/laconic-home-v3-375.png` and `/private/tmp/recommendation-card-qa/laconic-home-v3-430.png` (the responsive app frames are 375 and 430 CSS px).
- Focused implementation crop: `/private/tmp/recommendation-card-qa/laconic-implementation-card.png` (191 × 248 px).
- Same-input focused comparison: `/private/tmp/recommendation-card-qa/laconic-comparison-430.png`. The source was normalized to the implementation card width of 191 px; browser density is 1 captured pixel per CSS px.

**Findings**

- No actionable P0/P1/P2 mismatch remains in the annotated card-body scope.
- The card now follows the source's compact vertical sequence instead of reserving a second title row for every item. A one-line game card is 191 × 248 px at the 430 px breakpoint; a neighboring two-line training card grows naturally to 264 px.
- The participant stack is visually first and the occupied/capacity copy follows on the right, matching the reference reading order.
- The source crop contains a recommendation reason pill and favorite control. Both remain intentionally absent: the user explicitly removed the recommendation badge, and the current model exposes no favorite contract.

**Required fidelity surfaces**

- Fonts and typography: existing `RF Dewi` and `Inter Display` remain. The title keeps a two-line clamp but uses its natural one-line height (`line-height: 1.24`) when possible; time and metadata retain the compact 11/10 px hierarchy.
- Spacing and layout rhythm: title-to-metadata is 5 px, metadata-to-social is 8 px, social-to-CTA is 6 px. CTA height is 36 px. Responsive protective row minima are 246/250/260 px, while each card keeps its natural content height.
- Colors and visual tokens: the game type is now neutral gray like the annotated reference; training/tournament semantic colors remain. The compact CTA icon uses the specified primary brand purple `#6A5AF9` with a white plus glyph.
- Image quality and asset fidelity: the existing game WebP stays at the previously approved 72/76 px hero height and uses `object-fit: cover`; no new placeholder or generated decoration was introduced.
- Copy and content: real model values continue to drive event type, time, title, station/court, level/host, participants, availability, price, and route. `Вступить` is preserved because it reflects the existing game action policy rather than imitating reference copy.

**Comparison history**

1. User annotation identified a P2 density mismatch: the one-line game title reserved two lines and the flex layout pushed supporting information apart.
2. Removed the forced title/body height, changed social spacing from auto-fill to explicit compact gaps, and allowed short and long titles to take their natural height.
3. The first browser iteration exposed a P1 grid containment regression: fully automatic tracks inherited the fixed recommendation viewport height and let the next row overlap taller card content.
4. Restored responsive minimum grid tracks while keeping cards themselves content-sized. Post-fix geometry shows row two starting below row one, all cards reporting `scrollHeight <= clientHeight`, and no horizontal overflow.
5. The focused comparison then exposed reversed social order from a shared avatar-stack rule. Home V3 now explicitly orders avatars first and availability second.

**Interaction and runtime evidence**

- Browser console errors/warnings checked: none.
- Browser inspection confirms the compact CTA renders the brand-purple icon with its white plus glyph; the anchor has no visible text.
- Card links and CTA routes were preserved; focused component tests cover the existing action policy and routes.
- No overlap or horizontal overflow at the rendered 375 and 430 px app frames. The one-line game card measures 169.5 × 242.1 px at 375 and 191 × 248.1 px at 430.

**Follow-up polish**

- P3: event-specific media and favorite state still require proven existing contracts; do not fake them in the card.

**Implementation checklist**

- [x] Remove forced empty title row.
- [x] Tighten body, metadata, social, and CTA rhythm.
- [x] Keep short hero photography and recommendation badge removal.
- [x] Put participant avatars before availability copy.
- [x] Preserve Home V1/V2 and scope the change to Home V3.
- [x] Verify focused tests, 375/430 browser geometry, comparison image, and console.

final result: passed

---

# Follow-up QA — equal card rows and compact plus action (2026-08-26)

**Comparison target**

- Existing-product reference: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-source.png`, with the focused crop at `/private/tmp/recommendation-card-qa/equal-plus-reference.png`.
- Browser-rendered implementation: `http://127.0.0.1:5175/home-v3`, local synthetic recommendation state.
- Current 430 px implementation capture: `/private/tmp/recommendation-card-qa/equal-plus-home-v3-430.png`; focused crop: `/private/tmp/recommendation-card-qa/equal-plus-implementation.png`.
- Same-input comparison: `/private/tmp/recommendation-card-qa/equal-plus-comparison-430.png`.

**Findings**

- No actionable P0/P1/P2 mismatch remains in the annotated equal-height/footer scope.
- Every grid row now stretches its cards to the same height. At both 375 and 430 px, all three rendered cards measure 240 px high.
- Participant avatars, availability, and the action control share the same footer baseline. In the first row their social and action bottoms are identical at both verified widths.
- The full-width CTA was replaced with the existing compact plus control. The visible price is intentionally removed from the compact surface, while the action's accessible label still preserves the policy text and price (for example, `Вступить · 800 ₽`).

**Required fidelity surfaces**

- Fonts and typography: unchanged from the approved laconic Home V3 treatment.
- Spacing and layout rhythm: the body is a vertical flex container, the footer uses `margin-top: auto`, and the grid stretches cards within a 240 px row. This keeps short and two-line titles visually balanced without moving the footer.
- Colors and visual tokens: the compact action reuses the existing plus-button asset with the Home V3 brand fill `#6A5AF9` and its existing white plus.
- Image quality and asset fidelity: hero media and the approved 72/76 px crop remain unchanged.
- Copy and content: card data, links, routing, and action policy remain model-driven. The compact control is an accessible link for available events and a disabled button for unavailable events.

**Comparison history**

1. The previous iteration kept natural card heights and a full-width CTA, producing uneven row bottoms.
2. Reused the product's existing `CreateGameButtonIcon`, introduced a bottom-anchored footer, and stretched cards within each grid row.
3. Reduced the responsive track minimum from 260 px to 242 px after confirming that both one-line and two-line titles still fit without overflow.
4. Final same-input review confirms the source's equal-card/compact-plus behavior while retaining Home V3 photography and information hierarchy.

**Interaction and runtime evidence**

- Focused component and CSS tests pass (19 tests).
- Browser geometry at 375 px: three cards at 240 px, first-row social/action bottoms both at 704 px, no card or page horizontal overflow.
- Browser geometry at 430 px: three cards at 240 px, first-row social/action bottoms both at 703 px, no card or page horizontal overflow.
- Browser log review contains no application errors; only Vite connection and React development messages are present.
- Available-action and sold-out states are covered by component tests, including link routing, disabled semantics, accessible labels, and brand icon fill.

**Implementation checklist**

- [x] Equalize card heights within the recommendation grid.
- [x] Align avatars, availability, and action controls to the bottom.
- [x] Replace the full-width CTA with the existing compact plus control.
- [x] Preserve accessible action text, price, route, and disabled semantics.
- [x] Verify 375/430 px geometry, comparison input, focused tests, lint, typecheck, formatting, and diff whitespace.

final result: passed

---

# Follow-up QA — gradient-card avatar overlap in Home V3 (2026-08-26)

**Comparison target**

- Existing gradient-card source: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-source.png`; focused crop: `/private/tmp/recommendation-card-qa/avatar-overlap-source-crop.png`.
- Browser-rendered implementation: `http://127.0.0.1:5175/home-v3` at 430 px; screenshot: `/private/tmp/recommendation-card-qa/avatar-overlap-home-v3-430.png`.
- Focused implementation crop: `/private/tmp/recommendation-card-qa/avatar-overlap-implementation-crop.png`.
- Same-input comparison: `/private/tmp/recommendation-card-qa/avatar-overlap-comparison-430.png`.

**Findings**

- No actionable P0/P1/P2 mismatch remains in the requested avatar-overlap scope.
- Home V3 now reuses the gradient cards' exact avatar geometry: 32 px items, symmetric `-6px` side margins, and descending z-index order. Adjacent items advance by 20 px and visibly overlap by 12 px.
- Card height, footer baseline, availability copy, and compact plus action remain unchanged.

**Required fidelity surfaces**

- Fonts and typography: unchanged.
- Spacing and layout rhythm: avatar stack height is 32 px and uses the existing gradient-card overlap; the footer remains bottom-aligned with no horizontal overflow.
- Colors and visual tokens: existing avatar images, badges, and level colors are unchanged.
- Image quality and asset fidelity: the shared `ParticipantAvatarStack` and `PlayerLevelAvatar` rendering are reused; no replacement assets were introduced.
- Copy and content: participant names, availability, action labels, routes, and prices remain unchanged.

**Comparison history**

1. The photo-card variant used smaller 26 px items with `-4px` margins, producing a tighter but visibly different stack.
2. Replaced only those scoped geometry overrides with the established 32 px / `-6px` gradient-card values and retained its existing layer order.
3. Final browser evidence at 375 and 430 px confirms 32 px items, 12 px overlap, descending z-index, and no horizontal overflow.

**Implementation checklist**

- [x] Reuse gradient-card avatar size and overlap.
- [x] Preserve card height and footer alignment.
- [x] Verify 375/430 px geometry and horizontal containment.
- [x] Verify focused tests, lint, typecheck, formatting, and diff whitespace.

final result: passed

# Follow-up QA — open-slot circles replace occupancy copy (2026-08-26)

**Comparison target**

- Existing gradient-card source: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-source.png`; focused crop: `/private/tmp/recommendation-card-qa/avatar-overlap-source-crop.png`.
- Browser-rendered implementation: `http://127.0.0.1:5175/home-v3` at 430 px; screenshot: `/private/tmp/recommendation-card-qa/open-slots-home-v3-430.png`.
- Focused implementation crop: `/private/tmp/recommendation-card-qa/open-slots-implementation-crop.png`.
- Same-input comparison: `/private/tmp/recommendation-card-qa/open-slots-comparison-430.png`.

**Findings**

- No actionable P0/P1/P2 mismatch remains in the requested availability treatment.
- Game availability now matches the gradient-card pattern: two booked participant avatars followed by two overlapping open-slot circles for a 2-of-4 event.
- The visible `2 из 4 мест` copy is removed from the card while remaining available to assistive technology through the existing `sr-only` utility.
- Activity cards retain visible availability copy because their recommendation contract exposes capacity but not a participant roster; drawing a complete mixed roster there would invent participant state.

**Required fidelity surfaces**

- Fonts and typography: unchanged; only the visual occupancy label is suppressed for game cards.
- Spacing and layout rhythm: the four-item stack fits beside the 47 px action at both 375 and 430 px, with a 6 px footer gap and no collision or overflow.
- Colors and visual tokens: open slots reuse the existing shared `OpenSlotIcon` styling from the gradient cards.
- Image quality and asset fidelity: existing participant avatars, slot icon assets, and level badges are reused without replacements.
- Copy and content: occupancy remains in the accessibility tree; event data, routes, and action labels are unchanged.

**Comparison history**

1. The prior photo-card footer showed participant avatars followed by visible `2 из 4 мест` copy.
2. The game presentation now passes visible participants plus known open capacity into the shared four-slot stack and visually hides only the redundant occupancy label.
3. Final evidence at 375 px shows a 98.5 px social region ending before the action begins, with no footer or page overflow; 430 px shows the same four 32 px overlapping items.

**Implementation checklist**

- [x] Replace visible game occupancy copy with shared open-slot circles.
- [x] Preserve accessible occupancy text.
- [x] Keep activity capacity copy when no roster contract exists.
- [x] Verify 375/430 px footer containment and browser console.
- [x] Verify focused tests, lint, typecheck, formatting, and diff whitespace.

final result: passed

---

# Follow-up QA — separated activity host and participant slots (2026-08-26)

**Comparison target**

- Existing gradient-card source: `/Users/zver/Documents/Приложение ПаделхАБ/design-qa-home-v3-source.png`; focused activity-pattern crop: `/private/tmp/recommendation-card-qa/activity-host-slots-source-crop.png`.
- Browser-rendered implementation: `http://127.0.0.1:5175/home-v3` at 430 px; screenshot: `/private/tmp/recommendation-card-qa/activity-host-slots-home-v3-430.png`.
- Focused training crop: `/private/tmp/recommendation-card-qa/activity-host-slots-implementation-crop.png`.
- Same-input comparison: `/private/tmp/recommendation-card-qa/activity-host-slots-comparison-430.png`.

**Findings**

- No actionable P0/P1/P2 mismatch remains in the requested training/tournament roster treatment.
- Training and tournament cards reuse the existing activity-card structure: the trainer or organizer is rendered as one isolated 32 px host avatar, followed by an 8 px role boundary and a separate overlapping open-slot stack.
- The host is never inserted into the participant stack. Accessible groups explicitly distinguish `Тренер и свободные места` from `Организатор и свободные места`.
- Activity stacks show at most three open-slot circles beside the host, keeping the total visual group to four circles. The full capacity remains available through `Свободных мест: N` and the hidden occupancy label.

**Required fidelity surfaces**

- Fonts and typography: unchanged.
- Spacing and layout rhythm: trainer plus two slots and organizer plus three slots fit beside the 47 px action at both 375 and 430 px. There is no card, footer, or page overflow.
- Colors and visual tokens: host avatars and open-slot circles reuse the shared `ParticipantAvatarStack`, `PlayerLevelAvatar`, and `OpenSlotIcon` tokens from current gradient cards.
- Image quality and asset fidelity: real host media is used when supplied; the existing deterministic avatar fallback is retained otherwise.
- Copy and content: trainer metadata remains in the card; organizer/trainer role groups and the actual open count remain explicit to assistive technology. Routes and actions are unchanged.

**Comparison history**

1. The preceding game-only iteration left visible occupancy copy on activity cards.
2. Reused the established `booking-activity-card__host-roster`, host-avatar, and open-slots structure so role boundaries match current cards without inventing participant identities.
3. The first responsive pass exposed a 375 px collision for organizer plus four open slots.
4. Capped the visible activity slot sample at three while preserving the true open count in accessibility copy. Final geometry shows no collision at 375 or 430 px.

**Interaction and runtime evidence**

- Training fixture: separate trainer avatar, two open-slot circles, actual `Свободных мест: 2` label.
- Tournament browser state: separate organizer avatar, three visible open-slot circles, actual `Свободных мест: 6` label and hidden `10 из 16 мест` occupancy.
- Focused component and CSS tests pass (19 tests); browser console contains no application errors.

**Implementation checklist**

- [x] Separate trainer/organizer from participant slots.
- [x] Reuse current activity-card roster components and semantics.
- [x] Preserve actual capacity for assistive technology.
- [x] Prevent 375/430 px collisions and overflow.
- [x] Verify focused tests, lint, typecheck, formatting, diff whitespace, and browser console.

final result: passed

---

# Communications UI reference QA (2026-08-29)

**Comparison target**

- User-supplied visual reference: `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-2c13807f-ea5d-4327-96e3-3dbf523beec2.png` (1641 × 958 px).
- Browser-rendered implementation: `http://127.0.0.1:4173/communications-preview.html?view=desktop`, built from the actual `ChatsPage` and `NotificationsPage` components with deterministic synthetic data and no API mutation.
- Mobile implementation screenshots: `/private/tmp/lk2-comms-ui-evidence-20260829.3akvs7/chats-list-390x844.png`, `game-thread-390x844.png`, and `notifications-390x844.png`.
- Desktop split-view screenshot: `/private/tmp/lk2-comms-ui-evidence-20260829.3akvs7/chats-desktop-1440x900.png`.
- Same-input comparison: `/private/tmp/lk2-comms-ui-evidence-20260829.3akvs7/reference-vs-implementation.png`; each row places the normalized reference crop on the left and the implementation at the same 390 × 844 target on the right.

**Findings**

- No actionable P0/P1/P2 fidelity, behavior, accessibility, or responsiveness mismatch remains in the requested communications scope.
- [P3] The live conversation and notification contracts expose names and categories, but no participant avatar URL. The UI therefore uses deterministic initials or the existing chat icon instead of inventing people or importing remote imagery. Replace these fallbacks only after an existing safe media contract is available.
- The reference shows reaction, attachment, microphone, promotion, invitation, and tournament controls that are not present in the proven frontend contract. They remain intentionally absent rather than presenting fake actions or fabricated notification categories.
- The game context card contains only the proven game title, PadlHub context identifier route, and conversation kind. Court, level, payment, and participant facts from the visual reference are not invented.

**Required fidelity surfaces**

- Fonts and typography: existing RF Dewi and Inter Display assets are reused; headings, compact metadata, timestamps, unread counters, group sender labels, and bubble copy preserve the reference hierarchy without cramped wrapping.
- Spacing and layout: mobile list, full-screen thread, notification feed, and desktop split-view retain independent list/message scrolling, 44 px minimum controls, safe-area padding, restrained 12–22 px radii, and no decorative card stack.
- Colors and tokens: the current PadlHub purple remains the sole primary accent; pale-purple selected/context surfaces, neutral dividers, muted metadata, and disabled states match the source intent without gradients, glows, or glass effects.
- Icons and imagery: existing product navigation/chat icons are reused. No inline SVG illustration, emoji control, CSS hero art, or fake product image was added.
- Copy and content: only real DIRECT/GAME conversation kinds and GAME/BOOKING/BOOKING_REMINDER/ADMIN_MESSAGE notification categories receive dedicated labels. Unknown notification categories remain neutral and visible only under `Все`.

**Interaction, accessibility, and runtime evidence**

- Search matched Cyrillic titles and previews; clear-search restored results; DIRECT/GAME filters updated the loaded list without network behavior.
- Keyboard-only component coverage verifies focus order from the notifications shortcut through search, clear, and type filters. Composer coverage verifies Enter send, Shift+Enter newline, and IME-safe Enter handling.
- Notification category filtering and `Прочитать все` updated visible unread semantics. Safe internal deep links were preserved and external/protocol-relative links were rejected by focused tests.
- Responsive browser checks passed at 360 × 800, 390 × 844, 430 × 932, 768 × 1024, 1024 × 768, and 1440 × 900 with `body.scrollWidth = body.clientWidth`. A 200%-equivalent 1440 × 900 reflow check at 720 × 450 passed for both list and thread without horizontal overflow.
- The first visual pass exposed an empty-looking mobile refresh control; the final control is visibly labelled `Обновить`. The desktop pass exposed an incorrect four-column header assignment; the final title and refresh control occupy stable independent columns. The mobile thread now ends with the composer and hides the unrelated bottom navigation, matching the reference journey.
- Final static preview console check: zero warnings and zero errors.

**Implementation checklist**

- [x] Chats list, local search, DIRECT/GAME filters, unread indicators, and empty/error/loading surfaces.
- [x] Direct and game thread presentation, safe game context, day separators, own/foreign bubbles, and keyboard composer behavior.
- [x] Notification inbox, real category mapping, unread semantics, safe deep links, mark-all-read, and Web Push controls.
- [x] Mobile full-screen states plus desktop split-view and independent scrolling.
- [x] Same-input reference comparison, required responsive sizes, 200%-equivalent reflow, keyboard coverage, and console review.

final result: passed
