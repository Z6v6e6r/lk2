# Design QA: unified badge, attached tabs, and player typography

- Source visual truth paths:
  - `/private/tmp/padlhub-home-game-card-typography-source-20260722.png`
  - `/private/tmp/padlhub-home-tabs-source-20260722.png`
- Implementation screenshot path:
  `/private/tmp/padlhub-game-detail-final-round3-20260722.png`
- Result-entry interaction screenshot path:
  `/private/tmp/padlhub-game-detail-result-edited-round3-20260722.png`
- Focused comparison path:
  `/private/tmp/padlhub-game-detail-comparison-round3.png`
- Viewport: 931 x 1200 CSS px, device scale factor 1, with a 435 px application column and
  387 px content cards.
- Source crops: 363 x 223 and 355 x 70 pixels. Implementation: 931 x 1200 pixels. The focused
  comparison is 772 x 480 pixels at device scale factor 1.
- State: authenticated game detail with `Игра` selected; `Результат` was opened, the second score
  was changed from 0 to 4 without submitting, and the page was returned to a clean `Игра` state.

## Full-view comparison evidence

The current game-detail screenshot was inspected at the same 931 x 1200 viewport as the annotated
target. The badge now uses the Home rating icon, color, size, and copy without the transient
`Внести счёт` state. The 387 px tabs share the following card width and form its attached top edge.

## Focused region comparison evidence

The Home card and Home tabs source crops were combined beside the detail summary, tabs, and player
rows in one 772 x 480 comparison. The comparison confirms the shared Home SVG/type badge, RF Dewi
15 px / 600 player-name style, Inter Display 12 px / 500 level style, exact 387 px tab/card width,
zero vertical gap, and continuous 16 px outer radius around the combined tab-and-card block.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: game title and player names use the shared RF Dewi 15 px / 600 token;
  metadata and player levels use Inter Display 12 px / 500 with the same tracking and line height.
- Spacing and layout rhythm: tabs no longer bleed to the application edges; they match the next
  387 px card and attach with no seam or gap while later game blocks retain their 16 px rhythm.
- Colors and visual tokens: the Home rating badge, tab gradient, inactive opacity, card border,
  divider, and metadata colors are reused directly.
- Image quality and asset fidelity: the existing Home SVG and shared segmented level avatars are
  reused; no replacement or placeholder asset was introduced.
- Copy and content: the rating badge now says `Игра на рейтинг`, exactly as on Home, and no longer
  includes `Внести счёт`; live game, player, role, and level data remain intact.

## Interaction verification

- `Игра` and `Результат` switch without a route change.
- Result editor pair selectors and both score inputs render; score editing from 0 to 4 was verified
  visually without sending a result.
- The clean page has no Vite error overlay; browser console error log is empty.
- Focused tests passed (2 files, 10 tests).
- Full `npm run check --silent` passed (121 files, 561 tests, OpenAPI validation, package builds,
  and application builds); the five existing OpenAPI warnings remain non-blocking.

## Comparison history

1. The annotated state combined the Home card treatment with a state-bearing badge, full-width
   tabs, and small player copy.
2. The badge was switched to the exact Home SVG and rating label; the state suffix was removed.
3. Tabs were constrained to 387 px and grouped with the active panel; player typography was mapped
   to the Home card title and metadata tokens.
4. Post-fix browser, interaction, focused comparison, console, and repository checks found no
   remaining P0/P1/P2 issue.

## Implementation checklist

- [x] Reuse Home game-type badge SVG, label, color, and dimensions.
- [x] Remove `Внести счёт` from the summary badge.
- [x] Match tabs to the following card width and attach both blocks.
- [x] Reuse Home title/metadata typography for player names and levels.
- [x] Preserve and verify result entry behavior.
- [x] Run focused tests, full repository verification, and browser QA.

final result: passed

---

# Design QA: Home-aligned game detail

- Source visual truth paths:
  - `/private/tmp/padlhub-home-tabs-source-full-20260722.png`
  - `/private/tmp/padlhub-home-tabs-source-20260722.png`
  - `/private/tmp/padlhub-home-game-card-typography-source-20260722.png`
- Final implementation screenshot path:
  `/private/tmp/padlhub-game-detail-home-style-final-20260722.png`
- Full-view comparison path:
  `/private/tmp/padlhub-game-detail-home-style-full-comparison-20260722.png`
- Focused tab comparison path:
  `/private/tmp/padlhub-game-detail-tabs-edge-comparison-20260722.png`
- Focused card/avatar comparison path:
  `/private/tmp/padlhub-game-detail-home-card-comparison-20260722.png`
- Viewport: 931 x 1200 CSS px, device scale factor 1, with a 435 px application column.
- Source and implementation full-view screenshots: 931 x 1200 pixels. Focused crops were compared
  at native density without resampling.
- State: authenticated game detail with `Игра` selected; `Результат` was also opened and returned
  to `Игра` for interaction verification.

## Full-view comparison evidence

The Home and game-detail views were combined into one 1862 x 1200 image and inspected at original
resolution. The detail now carries the same Home visual language: compact activity card, green
uppercase type/state tag, RF Dewi title, two icon-led metadata rows, segmented level avatars, and
large gradient tabs with a white active underline.

## Focused region comparison evidence

The focused tab comparison confirms the same 50 px control height, 148 px button width, 12 px gap,
RF Dewi 18 px / 700 labels, 40% white inactive state, and 148 x 3 px white active underline. The
detail gradient spans the complete 435 px application width rather than stopping at the 24 px page
gutters.

The focused card/avatar comparison confirms that the match summary follows the Home card hierarchy
and metadata rhythm. Player rows reuse `PlayerLevelAvatar` through `ParticipantAvatarStack` at
48 x 51 px, with the level badge, level-specific accent, real photo/fallback behavior, and readable
player copy preserved.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: Home's RF Dewi title/tab weights and Inter Display metadata styles are
  reused directly; long live values stay single-line with available card width.
- Spacing and layout rhythm: the summary uses the Home tag/title/metadata/divider rhythm; player
  rows accommodate the 48 x 51 px avatars; the 50 px tab area bleeds to both application edges.
- Colors and visual tokens: the exact Home gradient, white selected/inactive states, green activity
  tag, white cards, gray metadata icons, and existing divider colors are reused.
- Image quality and asset fidelity: existing real profile photos and the shared segmented level
  avatar component are used; no substitute avatar artwork was introduced.
- Copy and content: title, game type/state, date range, station, court, players, levels, and roles are
  rendered from live game data.

## Interaction verification

- `Игра` and `Результат` both select correctly without a route change.
- The result editor opens with pair and score inputs, then returns to the game panel.
- Player profile links and the existing result/chat controls remain intact.
- Browser console errors checked: none.
- Focused component tests and full repository verification passed.

## Comparison history

1. The first annotated state used a compact white segmented control, calendar tile summary, and
   plain 34 px participant photos.
2. Tabs adopted the Home style but initially remained inside the detail card gutters.
3. The final pass expanded the gradient to the full 435 px application width, replaced the summary
   with the Home activity-card structure, and reused the shared level avatar component.
4. Post-fix full-view and focused comparisons found no remaining P0/P1/P2 drift.

## Implementation checklist

- [x] Reuse the Home activity-card hierarchy for the match summary.
- [x] Reuse Home typography and metadata icons.
- [x] Reuse the shared segmented level avatar for every participant.
- [x] Extend the tab gradient to both application edges.
- [x] Preserve tab switching, result entry, player links, and card actions.
- [x] Run focused tests, full repository verification, and clean-browser QA.

final result: passed

---

# Design QA: game detail summary typography

- Source visual truth path: `/private/tmp/padlhub-home-game-card-typography-source-20260722.png`
- Implementation screenshot path: `/private/tmp/padlhub-game-detail-typography-final-20260722.png`
- Full-view comparison path: `/private/tmp/padlhub-game-typography-full-comparison-20260722.png`
- Focused comparison path: `/private/tmp/padlhub-game-typography-comparison-20260722.png`
- Viewport: 931 x 1200 CSS px, device scale factor 1.
- Source and implementation screenshots: 931 x 1200 pixels. Focused crops are 363 x 223 and
  407 x 119 pixels; both were compared at native density without normalization.
- State: authenticated Home upcoming-game card compared with the authenticated game-detail summary.

## Full-view comparison evidence

The Home and game-detail screens were combined into one 1862 x 1200 image and inspected at original
resolution. The detail summary keeps the surrounding two-tab composition intact while adopting the
same strong-title and supporting-metadata hierarchy used by the Home game card.

## Focused region comparison evidence

The Home card and detail summary were combined into one 772 x 224 image. Computed styles match
exactly: strong text uses RF Dewi at 15 px / 600 / 16.8 px with 0.15 px tracking and `#1f1e20`;
supporting text uses Inter Display at 12 px / 500 / 12 px with 0.24 px tracking and `#353436`.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: both target and implementation use the same font families, sizes, weights,
  line heights, tracking, and text colors.
- Spacing and layout rhythm: the larger type fits without clipping; the summary grows from 92 px to
  98.6 px and preserves its padding, calendar alignment, and following tab spacing.
- Colors and visual tokens: the Home card foreground tokens are reused exactly.
- Image quality and asset fidelity: no image assets changed; the calendar tile remains sharp and
  aligned.
- Copy and content: live date, time, court, and station values remain unchanged.

## Interaction verification

- The `Игра / Результат` control remains visible and unchanged after the typography update.
- Browser console errors checked: none.
- Repository verification: `npm run check --silent` passed.

## Comparison history

1. The annotated detail summary used 11 px / 800 RF Dewi strong text and 10 px supporting text.
2. It was changed to the Home card's 15 px / 600 title and 12 px / 500 metadata tokens.
3. The final focused comparison and computed-style check found no remaining P0/P1/P2 drift.

## Implementation checklist

- [x] Reuse the Home card title typography.
- [x] Reuse the Home card metadata typography.
- [x] Preserve the summary layout and calendar tile.
- [x] Verify the final browser render and computed styles.

final result: passed

---

# Design QA: two-tab game detail

- Source visual truth path:
  `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-05d2488a-2e69-4f59-b34e-10ffe761707a.png`
- Final implementation screenshot path:
  `/private/tmp/padlhub-game-detail-game-final-20260722.png`
- Result-tab implementation screenshot path:
  `/private/tmp/padlhub-game-detail-result-20260722.png`
- Combined full-view comparison path:
  `/private/tmp/padlhub-game-detail-comparison-final-20260722.png`
- Combined focused comparison path:
  `/private/tmp/padlhub-game-detail-top-comparison-20260722.png`
- Viewport: 435 x 666 CSS px, device scale factor 1.
- Source pixels: 435 x 666. Implementation pixels: 435 x 666. No density normalization was
  required.
- State: authenticated finished four-player game; `Игра` selected for source comparison and
  `Результат` selected for interaction verification.

## Full-view comparison evidence

The reference and final implementation were combined into one 894 x 702 image and inspected at
original resolution. The implementation matches the source's compact left-aligned header, date and
court summary card, calendar tile, white two-option segmented control, solid purple active state,
white participant card, light gray background, thin borders, rounded corners, and compact type
hierarchy. Real game data expands the participant card from one row to four rows as expected.

The existing PadlHub bottom navigation remains in the application shell and the result-specific
editor replaces the reference's non-product `Game not found` and duplicate `Отлично` controls.
These are intentional product constraints rather than visual drift.

## Focused region comparison evidence

The top 435 x 390 region from both images was combined and inspected separately. Header baseline,
summary-card width, 16 px card radii, calendar-tile proportions, tab height, active fill, participant
heading, count placement, avatar scale, organizer badge, and row separators remain visually aligned.
The implementation uses live names, photos, court, station, date, and level data instead of copying
the screenshot's sample values.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: RF Dewi is used for the header, card headings, active tabs, badges, and
  primary actions; Inter Display is used for supporting data and labels. Weight, compact sizing,
  hierarchy, and truncation follow the reference while keeping live long names readable.
- Spacing and layout rhythm: the 435 px frame, 24 px page gutters, 14-16 px card radii, compact
  summary, 42 px tab control, participant rows, and card gaps preserve the source rhythm. The app
  keeps 112 px bottom padding for its fixed navigation.
- Colors and visual tokens: detail background is `#f7f7f8`, cards are white, borders use the
  existing light-gray palette, and the active/primary state uses the existing PadlHub purple family.
- Image quality and asset fidelity: live participant photos keep circular cover crops; missing
  photos use compact initials; pair placeholders reuse the existing `ParticipantAvatarStack`
  open-slot asset instead of recreating an icon.
- Copy and content: `Детали матча`, `Игра`, `Результат`, participant roles, match data, and result
  workflow labels are localized and data-driven. The game-level team model is not implied: the
  format card states that pairs are selected separately for every set.

## Interaction verification

- `Игра` and `Результат` switch in place without changing the route.
- `Игра` exposes participant profiles, the match chat, and the available primary game action.
- `Результат` exposes the existing pairing and per-set score editor for `RESULT_REQUIRED`.
- Submitted-set and confirmation controls are covered by component tests for
  `PENDING_CONFIRMATION`.
- Browser console warnings and errors checked: none.
- Repository verification: `npm run check --silent` passed, including 121 test files and 561 tests.

## Comparison history

1. The first render matched the reference structure but retained the generic `#fafafa` Games
   background and the browser's default green keyboard-focus outline.
2. The detail background was aligned to `#f7f7f8`, and tab focus was replaced with a visible
   purple-family focus ring.
3. The final 435 x 666 capture was compared again with the source and has no remaining P0/P1/P2
   findings.

## Implementation checklist

- [x] Replace the generic detail card stack with one match-detail composition.
- [x] Add working `Игра / Результат` tabs without a route change.
- [x] Preserve live roster, chat, and lifecycle actions.
- [x] Keep pair selection inside individual result sets.
- [x] Render pending and confirmed result states with pair snapshots.
- [x] Add regression tests for tab switching and result confirmation actions.
- [x] Run full repository verification and authenticated browser QA.

final result: passed

---

# Design QA: profile level avatar

- Source visual truth: `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-fdef154a-7101-423f-919c-857a6c98f69d.png`
- Previous implementation screenshot: `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-8cdfe9bc-3287-4411-8769-e04ee30c43c6.png`
- Updated implementation screenshot: `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-shot-2026-07-16_14-29-47.png`
- Implementation viewport: 375 px application column inside the desktop browser
- State: authenticated Home profile with a real user photo and `C` level

## Full-view comparison evidence

The updated Home screen was captured after the web container restart. The profile avatar keeps
the prototype's compact `48 x 51` footprint and remains aligned with the name and balance block.
The live `C` level has fewer filled rank segments than the prototype's illustrative `D+` state;
this is expected data-driven behavior rather than visual drift.

## Focused region comparison evidence

The prototype, previous implementation crop, updated browser render, and component geometry were
compared:

- Root: `48 x 51` px.
- Rank ring: `48 x 48` px.
- Photo: `40 x 40` px at `left: 4px; top: 4px`.
- Photo radius: `40px`.
- Level badge: `22 x 14` px at `left: 13px; top: 37px`.
- Level type: RF Dewi, weight 700, size 9 px, line height 11 px.

## Findings

No remaining P0, P1, or P2 visual differences were found in the component geometry.

## Required fidelity surfaces

- Fonts and typography: badge values match the supplied RF Dewi specification.
- Spacing and layout rhythm: root, ring, photo, and badge use the supplied Figma dimensions.
- Colors and visual tokens: filled and inactive ring colors remain white and 24% white.
- Image quality and asset fidelity: the live Viva photo is preserved with a circular cover crop.
- Copy and content: level labels remain data-driven; the prototype's `D+` is not hard-coded.

## Comparison history

1. Earlier implementation used `inset: 6px` on a `48 x 51` root.
2. This produced a `36 x 39` photo mask, making the avatar slightly oval and too small.
3. The mask was replaced with the literal prototype dimensions: `40 x 40` at `(4, 4)`.
4. The updated browser render confirms a circular mask and prototype-matched proportions.

## Implementation checklist

- [x] Match the `48 x 51` component frame.
- [x] Match the `40 x 40` photo and its `(4, 4)` position.
- [x] Match the `22 x 14` level badge and its `(13, 37)` position.
- [x] Preserve live photo, level, and rank-progress data.
- [x] Verify the updated component in the running local application.
- [x] Run web formatting, lint, typecheck, App tests, and production build.

The repository-wide `npm run check` was also started, but its formatting stage is currently
blocked by unrelated concurrent Web Push changes in `packages/notifications/src/index.ts`.

final result: passed

---

# Design QA: shared game participant stack

- Source visual truth path:
  `/var/folders/8c/gdhtwlnn3cn6k90ylgk3bn880000gn/T/codex-clipboard-66807ddf-798e-4d2b-847c-d1bd3b764741.png`
- Focused implementation screenshot path:
  `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa/participant-stack-history.png`
- Full implementation screenshot path:
  `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa/participant-stack-history-full.png`
- Viewport: 931 x 1200 px.
- State: authenticated History modal, visited games, game cards without recorded score sets.

## Full-view comparison evidence

The updated History modal was captured at the browser-comment viewport. Every visible game card
without score sets uses the same compact participant stack as Home: four overlapping 48 px player
avatars, segmented level rings, and level badges aligned below the photos. Result-bearing cards keep
their result-specific participant presentation.

## Focused region comparison evidence

The supplied 175 x 72 px reference and the 176 x 68 px implementation crop were inspected together.
Both show the same four-avatar rhythm, circular photos or open-slot state, white separating edges,
orange/red level badges, and badge overlap below the avatar ring.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: level labels reuse the canonical `PlayerLevelAvatar` badge typography.
- Spacing and layout rhythm: the stack keeps the Home component's 48 px avatars and negative
  horizontal overlap within a 160 x 52 px frame.
- Colors and visual tokens: participant ring and level colors come from the existing level palette;
  no new card-specific palette was introduced.
- Image quality and asset fidelity: live participant photos retain circular cover cropping; empty
  places reuse the existing Home open-slot asset.
- Copy and content: participant names and levels remain data-driven; no reference content is
  hard-coded.

## Interaction verification

- Home and History render the same shared participant-stack component.
- Participant profile links remain active when a PadlHub user UUID is available.
- Cards without results fill empty places up to game capacity.
- Browser console warnings and errors checked: none.

## Comparison history

1. The History cards previously used a separate compact avatar implementation.
2. The canonical Home participant stack was extracted without changing its visual geometry.
3. History cards without score sets now map their participants into that shared component.
4. The focused and full browser captures show no remaining P0/P1/P2 mismatch.

## Implementation checklist

- [x] Reuse one participant component on Home and no-result game cards.
- [x] Preserve the existing result-card participant presentation.
- [x] Preserve participant profile navigation.
- [x] Add no-result card regression coverage.
- [x] Verify the requested 931 x 1200 px browser state and console.

final result: passed

---

# Design QA: Home calendar one-day paging

- Source visual truth path: Browser comments 1 and 2 conversation attachments (Codex Desktop did
  not expose local attachment paths).
- Implementation screenshot path:
  `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa-home-calendar-day-swipe-2026-07-21.png`
- Viewport: 931 x 1200 px browser viewport with the 375 px Home application column centered.
- State: authenticated Home, `Мои записи`, initial date range, `Все даты` selected.

## Full-view comparison evidence

The updated browser capture was compared with both annotated Home screenshots. The calendar keeps
the same eight-chip width, 55 px height, date typography, filter row position, booking card position,
and surrounding Home layout. Only the requested paging behavior and `Все даты` text states changed.

## Focused region comparison evidence

- One forward swipe changes `21–27 июля` to `22–28 июля`, proving a one-day step.
- Fourteen forward swipes produce `4–10 августа`; a fifteenth forward swipe leaves that range
  unchanged.
- One backward swipe from the limit produces `3–9 августа`.
- Unselected `Все даты` computed color: `rgba(31, 30, 32, 0.4)`, matching an unselected date label.
- Selected `Все даты` computed color: `rgb(31, 30, 32)`, matching selected date labels.
- Chip geometry remains 46 x 55 px with 10 x 8 px padding.

## Findings

No actionable P0, P1, or P2 mismatch remains. The blue outlines and numbered circles in the source
are browser-annotation markers rather than product UI and were not reproduced.

## Required fidelity surfaces

- Fonts and typography: `Все даты` retains RF Dewi at 9 px, weight 700, 10 px line height, and
  0.02 em tracking; date-chip typography is unchanged.
- Spacing and layout rhythm: chip size, count, gaps, calendar height, type filters, and booking-card
  placement are unchanged.
- Colors and visual tokens: reset text now uses the exact existing date-label inactive and active
  colors.
- Image quality and asset fidelity: no image or icon asset changed.
- Copy and content: `Все даты` and all localized date labels remain unchanged.

## Interaction verification

- Forward swipe: one day per gesture.
- Backward swipe: one day per gesture, bounded at the current date.
- Forward bound: start offset capped at 14 days.
- Date selection still clears `Все даты`; reset selection still clears the date filter.
- Browser console errors checked: none.

## Comparison history

1. Earlier behavior moved the seven-date window by a full week and allowed two week-sized steps.
2. The offset unit was changed from weeks to days while preserving the same swipe gesture.
3. Browser evidence confirmed the one-day step, +14-day cap, reverse step, and both text colors.

## Implementation checklist

- [x] Page the calendar one day per swipe.
- [x] Cap forward paging at +14 days.
- [x] Keep backward paging bounded at today.
- [x] Match `Все даты` inactive and active colors to date chips.
- [x] Preserve chip dimensions and surrounding layout.
- [x] Add boundary and step regression coverage.
- [x] Run focused formatting, lint, typecheck, 33 tests, and authenticated browser QA.
- [x] Build the web application.
- [ ] Repository-wide `npm run check` reaches lint and is blocked by unrelated concurrent errors in
      `activity-history-game-backfill.ts` and `legacy-games-adapter/src/index.test.ts`.

final result: passed

---

# Design QA: Home booking date reset and history action

- Source visual truth path: Browser comments 1 and 2 conversation attachments (Codex Desktop did not expose a local attachment path), plus the supplied Figma CSS for `Frame 2131331843`.
- Implementation screenshot path: `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa-home-booking-filters-2026-07-21.png`
- Viewport: 1420 x 1200 px browser viewport with the 375 px Home application column centered.
- State: authenticated Home, `Мои записи`, all booking dates visible, history modal closed.

## Full-view comparison evidence

The browser render was compared with both annotated source images in the same viewport context. The
new `Все даты` badge sits directly before the current date without horizontal overflow or changes to
the surrounding Home sections. The old two-option footer is replaced by a single full-width history
action below the dashed divider.

## Focused region comparison evidence

- Calendar frame: 375 x 55 px.
- Calendar controls: eight 46 x 55 px buttons with 1 px gaps; measured `scrollWidth` and
  `clientWidth` are both 375 px.
- `Все даты` uses the same measured 46 x 55 px frame and 10 x 8 px padding as every date chip;
  there is no smaller nested chip.
- Footer frame: 375 x 45 px.
- Dashed-divider-to-action gap: 12 px.
- Action wrapper: 375 x 33 px with 24 px horizontal padding.
- `История посещений` button: 327 x 33 px, `#FAFAFA` background, 8 px radius.

## Findings

No actionable P0, P1, or P2 mismatch remains. Live booking and promotion content differs from the
static annotated capture as expected; those data-driven regions were outside the requested change.

## Required fidelity surfaces

- Fonts and typography: the history label uses Inter Display, 500 weight, 12 px size, 100% line
  height, and 0.02 em tracking. The reset badge reuses the existing compact calendar typography.
- Spacing and layout rhythm: the supplied 375 x 45, 375 x 33, and 327 x 33 geometry is present in
  the browser render; all eight calendar controls fit exactly within 375 px.
- Colors and visual tokens: the action uses `#FAFAFA` and `#353436`; the reset badge reuses the
  existing Home borders and selected-state colors.
- Image quality and asset fidelity: no image or icon asset was added or replaced by this change.
- Copy and content: visible labels are exactly `Все даты` and `История посещений`.

## Interaction verification

- Selecting 22 July changed the date button to `aria-pressed=true`, cleared `Все даты`, and reduced
  the visible booking cards from two to one.
- Activating `Все даты` restored `aria-pressed=true` on the reset badge and both booking cards.
- Activating `История посещений` opened the existing `История` dialog without changing `/`.
- Browser console errors checked: none.

## Comparison history

1. The source had seven dates and a two-option `Все записи / История` footer.
2. The implementation added the requested reset badge while retaining all seven visible dates.
3. The footer was reduced to the supplied 45 px frame and its single 33 px history action.
4. The final browser capture and measured geometry show no remaining P0/P1/P2 mismatch.
5. After the focused chip reference, the smaller nested `Все даты` frame was removed; browser
   geometry confirms that the reset and date chips now have identical dimensions and padding.

## Implementation checklist

- [x] Add `Все даты` before the current date.
- [x] Reset the selected date without changing the type filter.
- [x] Replace the footer switcher with `История посещений`.
- [x] Keep the existing history modal behavior.
- [x] Add regression coverage for date reset and history opening.
- [x] Run browser interaction and console verification.
- [x] Run focused web formatting, lint, typecheck, 33 tests, production build, and browser QA.
- [ ] Final repository-wide `npm run check` rerun is blocked by unrelated concurrent lint errors in
      `activity-history-game-backfill.ts` and `legacy-games-adapter/src/index.test.ts`; the preceding
      full run passed before the chip-only CSS refinement.

final result: passed

---

# Design QA: shared Home and History typography

- Source visual truth path:
  `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa/game-card-shared-typography-home.png`
- Implementation screenshot path:
  `/Users/zver/Documents/Приложение ПаделхАБ/output/design-qa/game-card-shared-typography-history.png`
- Viewport: 931 x 1200 px.
- State: authenticated Home booking card and visited-games History modal.

## Full-view comparison evidence

The Home and History captures were inspected together at the same viewport. Game titles and metadata
rows now use one shared typography contract, while each surface keeps its existing layout, card
dimensions, status treatment, participant stack, and actions.

## Focused region comparison evidence

- Home and History title computed styles both resolve to RF Dewi, 15 px, weight 600, 16.8 px line
  height, 0.15 px tracking, and `rgb(31, 30, 32)`.
- Home and History metadata rows both resolve to Inter Display, 12 px, weight 500, 12 px line height,
  0.24 px tracking, and `rgb(53, 52, 54)`.
- History title links retain navigation while rendering without browser-default blue or underline.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Required fidelity surfaces

- Fonts and typography: exact Home family, size, weight, line height, tracking, and color are shared
  by the History game title and metadata rows.
- Spacing and layout rhythm: no card spacing, footer, or participant geometry changed.
- Colors and visual tokens: title and row foreground colors now match Home; status colors are
  unchanged.
- Image quality and asset fidelity: avatars and all image assets are unchanged.
- Copy and content: game names, schedules, venues, levels, and actions remain data-driven and
  unchanged.

## Interaction verification

- Home booking cards remain visible and navigable.
- `История посещений` opens the History modal.
- Game title links and participant links remain active.
- Browser console warnings and errors checked: none.

## Comparison history

1. The initial History render kept legacy 20 px / 720 title styling and 11 px metadata.
2. Shared typography classes were added to Home and compact History cards.
3. Existing high-specificity History rules were found to override the shared title size.
4. The shared contract was given matching selector specificity; the final computed styles are now
   identical across both surfaces.

## Implementation checklist

- [x] Share title typography between Home and compact History cards.
- [x] Share metadata-row typography between Home and compact History cards.
- [x] Preserve title navigation and non-typographic card behavior.
- [x] Add compact-card regression coverage.
- [x] Verify both browser states and console at 931 x 1200 px.

final result: passed
