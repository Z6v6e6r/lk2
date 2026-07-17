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
