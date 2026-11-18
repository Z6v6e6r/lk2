# LK2 client load — measurement report (2026-11-18)

Branch: `codex/lk2-performance-client` (PR #678), split out of #670. Companion API change:
`codex/lk2-performance-media` (PR #679). Main `1bd9d6c5c2dfc0c3f1d6f178317037342da36a4a`
(PRs #680/#681) is merged in; this branch did not edit supervisor, publication-workflow or release-guard
files.

**Measured code head: `4ade878e9b532bb92cbcd2510136e05de5ad1d72`.** CI and the documentation head are
recorded in PR #678.

## 1. What is proven

After the run-provenance repair, with 7 alternating valid runs per variant and scenario:

- **Home (`базовый Home`)**: displayed 2665 → 2547 ms median (**-4.4%**); the required response
  boundary is 230 ms earlier (**-11.1%**). Recommendations become ready 127 ms earlier.
- **Profile**: displayed 3198 → 2864 ms (**-10.4%**); API payload 5043 → 4168 B (**-17.4%**);
  total network -10.1%.
- **Games**: parity (-0.5%); the marker is now bound to the Games screen container and the completed
  `EVENT_CATALOG` job.
- **Repeat open**: parity (+2.2%).
- **Home → Games**: 1639 → 1225 ms median (**-25.3%**); the transition window transfers 3 128 B
  instead of 24 254 B because the games chunk is warm.
- **Cold Profile boundary** (the review item): the Profile run has 12 requests and 4168 B, with **no**
  Home base or booking-screen read job. The earlier 7217 B figure contained a 2174 B Home read-job
  continuation; it is corrected by attribution, not by subtracting bytes from the old result.

All 84 attempts are valid; all absolute values are LOCAL, synthetic, throttled-browser evidence.

## 2. Frozen comparison inputs

| Item                       | Value                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Baseline                   | `origin/main` worktree at `adfb7d4c76fc742d6d286eeca990de07dd0b5431`, production build of `apps/web` |
| Candidate                  | code head `4ade878e9b532bb92cbcd2510136e05de5ad1d72`, same build command                             |
| Variants                   | baseline = plain main; candidate = #678 only; no media or server change                              |
| Browser                    | Chrome/157.0.8103.79, headless                                                                       |
| Stand                      | `scripts/perf/measure-app-scenarios.js` (harness `scenario-stand-2026-11-18`, provenance revision)   |
| Viewport                   | 412×915, device scale 2.625                                                                          |
| CPU / network              | 4× CPU throttle; 1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT                                          |
| Stub API                   | `scripts/perf/stub-lk2-api.js`, fixed 120 ms per read, fixtures from `apps/web/src/App.test.tsx`     |
| Runs                       | 7 repetitions per variant and scenario, alternating variant order                                    |
| Session                    | one synthetic session restored through `/auth/session/refresh`; same account and tenant in every run |
| Cache, cold scenario       | `Network.clearBrowserCache` before every run; no Service Worker; no application-level data cache     |
| Cache, repeat scenario     | one full cold Home load, then the measured open with the HTTP cache kept                             |
| Cache, transition scenario | cache cleared, Home loaded, 1 s settle, then the in-app action; the clock starts at the action       |

Raw data: [series JSON](measurements/series-final-20261118.json),
[series CSV](measurements/series-final-20261118.csv),
[Home → cold Profile boundary](measurements/boundary-home-profile-20261118.json),
[provenance checks](measurements/run-isolation-attribution-20261118.txt).
The previous series is preserved verbatim as
[pre-isolation JSON](measurements/series-final-20261118-pre-isolation.json) /
[pre-isolation CSV](measurements/series-final-20261118-pre-isolation.csv); the CSS series is unchanged.

Reproduce with the commands in §8.

## 3. The stand: one clock, document provenance, typed markers

**One clock.** Every duration is page time: a document navigation starts at the navigation entry
(`startTime` 0), the in-app transition at `window.__PHUB_NAV_START` captured at the action. Request,
marker and paint times come from `performance.getEntriesByType(...)`/`performance.now()` on that
timeline. Node wall clock is bookkeeping only and is never used in a duration.

### 3.1 Request provenance (review item 2)

- The harness now **closes the previous document and waits until `about:blank` has committed before
  it opens the next run epoch**. A new epoch therefore cannot begin while the old page can still start
  a continuation request.
- Every document carries an explicit run id. An injected wrapper adds `X-Perf-Run-Id` to `fetch`
  and `XMLHttpRequest`; the in-app transition switches the id at the action mark, so the warm Home
  document keeps its own id until the tap.
- The stub resolves attribution **at request arrival, before any `await`, including the POST body
  read**, in this order: read-job origin run (the job id encodes it) → document header → open epoch.
  The body read can no longer move a request.
- A run snapshot is frozen only after the run has no in-flight request. Completed server-side requests
  are compared with the document's API resource entries: **70/70 snapshot-bearing attempts match**
  (the 14 background attempts take no snapshot boundary). Requests visibly owned by the warm Home job
  are filtered by the run encoded in the job id, not counted in the transition run.
- After the freeze the harness reads `/__perf/run/:id/live`; the frozen snapshot is re-read and compared
  byte for byte.

**Address checks** (`scripts/perf/verify-run-isolation.js`, 15/15, also a CI test
`scripts/perf/run-isolation.test.ts`):

1. a read-job `/complete` that starts after a new run opened stays with the originating run;
2. the epoch changes while the POST body is being read — the request stays in its original run;
3. a late completion changes the old run's live accounting while the frozen snapshot stays unchanged.

**Sequential boundary proof** (one Home load, then a cold Profile):
[boundary-home-profile-20261118.json](measurements/boundary-home-profile-20261118.json) — Profile
12 requests / 4168 B / 0 Home base / 0 read-job requests, counts match, **0 live late completions**, and
the recommendations/profile-ready markers are present.

### 3.2 Markers (review item 3)

| Metric                              | Condition / meaning                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `displayedMs` (Home)                | the existing metric, reported as **«базовый Home»**: bottom nav, viewer heading, `/home/base` response |
| `displayedMs` (Profile)             | `#profile-name`, the balance block, `/profile`                                                         |
| `recommendationsDisplayedMs` (Home) | first recommendations applied **or** a confirmed empty page, confirmed by a dedicated DOM signal       |
| `profileReadyDisplayedMs` (Profile) | the real profile section, confirmed by a dedicated DOM signal                                          |
| `displayedMs` (Games / nav)         | a card inside `.games-page .games-list` whose id came from the completed `EVENT_CATALOG` job           |
| `catalogDisplayedMs`                | the Games catalog container is ready; the API side is the `EVENT_CATALOG` completion                   |
| `requiredResponseEndMs`             | max `responseEnd` of **all** required completed responses, bounded by the signal's DOM time            |
| `renderAfterResponseEndMs`          | `displayedMs - requiredResponseEndMs`                                                                  |
| `refreshRequestMs` (background)     | focus event → next `/home/base` request start, page clock                                              |

- The responseEnd-derived metric is renamed `requiredResponseEndMs`; no `requiredDataAppliedMs` key
  remains in the output.
- A required read is satisfied only when **every** listed response is present, including the job's
  screen. For Games the required input is the `EVENT_CATALOG` start and completion; an arbitrary
  `/complete` is not accepted.
- Application and display are confirmed by DOM signals (`data-perf-ready`, `data-perf-screen`,
  `data-game-id`), then by a double `requestAnimationFrame` for the displayed time. The baseline build
  has no such attributes; its marker uses the equivalent pre-existing DOM classes, so both variants are
  judged on the same render event. Games cards are checked against the catalog ids:
  **28/28 card sets bound** (Games + transition, both variants).
- The fixtures always return recommendations, so the confirmed-empty branch did not occur in this
  series (0/84); the marker supports it and the empty state carries its own signal.

**Late completions.** The old phrase “0 late completions” is removed: a frozen snapshot cannot describe
future completions. Live readback after close reports **35 late completions in 84 runs** (repeat 14,
background 21; max 2 per run), all attributed to their own run; every frozen snapshot stayed
byte-identical. The sequential boundary run reports 0 because its Profile run is fully idle at the
freeze.

## 4. Results (median [min..max], 7 valid runs each)

| Scenario     | metric                     | baseline          | candidate         | delta                           |
| ------------ | -------------------------- | ----------------- | ----------------- | ------------------------------- |
| Home         | displayed («базовый Home») | 2665 [2627..2749] | 2547 [2485..2582] | **-118 ms / -4.4%**             |
| Home         | recommendations displayed  | 3876 [3853..4479] | 3749 [3698..4366] | **-127 ms / -3.3%**             |
| Home         | `requiredResponseEndMs`    | 2079 [2065..2111] | 1849 [1837..1872] | **-230 ms / -11.1%**            |
| Home         | total network              | 332 229 B         | 340 744 B         | +8 515 B / +2.6% (prefetch)     |
| Profile      | displayed                  | 3198 [3138..3215] | 2864 [2798..4262] | **-334 ms / -10.4%**            |
| Profile      | profile ready              | 3198 [3138..3215] | 2864 [2798..4262] | **-334 ms / -10.4%**            |
| Profile      | `requiredResponseEndMs`    | 2431 [2406..2439] | 2031 [2005..3408] | **-400 ms / -16.5%**            |
| Profile      | API payload                | 5043 B            | 4168 B            | **-875 B / -17.4%**             |
| Profile      | total network              | 336 673 B         | 302 619 B         | **-34 054 B / -10.1%**          |
| Games        | displayed                  | 2855 [2846..3054] | 2842 [2817..2996] | -13 ms / -0.5% (parity)         |
| Games        | total network              | 321 080 B         | 308 470 B         | -12 610 B / -3.9%               |
| Repeat open  | displayed                  | 2667 [2236..2766] | 2726 [2684..2786] | +59 ms / +2.2% (parity)         |
| Home → Games | displayed                  | 1639 [1094..1672] | 1225 [675..1299]  | **-414 ms / -25.3%**            |
| Home → Games | window network             | 24 254 B          | 3 128 B           | **-87.1%** (chunk already warm) |
| Background   | refresh request            | 1 [1..3] ms       | 1 [1..2] ms       | floor measurement               |

Request counts (median): Home 11/11, Profile 12/12, Games 4/4, Repeat 11/11, transition 3/3.
API payload medians: Home 5775/5775 B, Profile 5043/4168 B, Games 2965/2965 B, transition 2535/2535 B.

### How to read the result

- **Home and Profile are faster; the byte effect is separate.** Home displays 4.4% earlier and applies
  its required data 11.1% earlier; Profile displays 10.4% earlier and carries 17.4% less API payload.
  The Home network total rises 2.6% because the next screen's chunk is fetched after the first data.
- **The transition is much cheaper at the median**: the games chunk is already warm and the window
  transfers 3.1 KB instead of 24.3 KB. Its spread is still wide (675..1299 ms candidate) and the action
  keeps the **1 s settle after Home**; the range, not the median alone, is the honest summary.
- **Games and repeat are parity.** A single earlier series showed a larger repeat win; it is not
  carried here.
- Seven runs give a median and a range, not a p95. Slow values stay in the CSV.
- Profile's candidate range contains one 4262 ms sample; the median and the 2798 ms minimum are reported
  with it rather than deleting the slow run.

## 5. What changed in the client (PR #678)

1. Lazy screens with their own Suspense boundary.
2. Startup priority for badge and secondary profile reads, with `shouldStart`.
3. A read coalescer invalidated after the commands that change those lists.
4. Booking preference stations from `listLocations()` instead of a 50-game read.
5. A post-paint prefetch of the games chunk.
6. Inert measurement signals (`data-perf-screen`, `data-perf-ready`, `data-game-id`) on the marked
   containers; they add no behavior, style or network request.

## 6. Re-measurement and replaced data

The previous series is preserved unchanged as `series-final-20261118-pre-isolation.*` with its exact
old definitions. It is not combined with the new numbers.

| Data replaced       | Why                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home, Profile       | The old epoch opened before the old document left; cold Profile inherited the Home read-job continuation (the 2174 B gap) and the old page's work inflated Profile times. The Home run boundary now ends at recommendations readiness, so Home byte totals include the recommendation reads and are not comparable to the pre-isolation Home totals. |
| Games, Home → Games | The old marker accepted a generic `.game-card` and any `/complete`; the new marker requires the Games screen container, the completed `EVENT_CATALOG` job and matching catalog ids. This is a different measured event.                                                                                                                              |
| Repeat, Background  | They share the repaired document/epoch boundary and now report live late completions.                                                                                                                                                                                                                                                                |
| CSS series          | **Not rerun.** The CSS experiment is closed and reverted; its data and conclusion are unchanged.                                                                                                                                                                                                                                                     |

The full 84-run series was rerun because every scenario shares the repaired boundary; it is not a
per-scenario cherry-pick. All 84 attempts are valid.

## 7. Checks (LOCAL) and CI

- `prettier --check` and ESLint pass on the changed files; `tsc -p tsconfig.web-app.json` and
  `tsc -p tsconfig.tools.json` pass; `npm run build -w @phub/web` passes.
- 172 tests pass (App, ProfilePage, BookingRecommendations, the 15-check provenance test).
- `GamesPage.test.tsx` has 28 failures in this local Node 26 environment on `window.localStorage`
  being undefined; the **unchanged baseline worktree fails identically** (28/62). It is a local
  environment defect, not this diff; CI runs the supported Node version.
- CI on the measured code head `4ade878e9` (run 44289047601): `ci-plan`, `secret-scan`,
  `source-quality`, `dependency-security`, `deployment-contract`, `docker-selection`, Android
  build and iOS simulator are green. `quality-full` failed only on
  `scripts/timeweb-standard-compose.test.ts > rehearses actual isolated Compose Web success and
forced same-digest rollback`: its own `spawnSync` 180 s limit was reached (180064 ms). This branch
  does not touch that test, Compose or any release file; it is a Docker-rehearsal wall-clock failure
  on the runner, not a result of this diff. The exact-head CI of the final documentation commit is
  recorded in PR #678.

## 8. Reproduce

```
npm run build -w @phub/web
PHUB_STUB_PORT=4181 PHUB_STUB_LATENCY_MS=120 node scripts/perf/stub-lk2-api.js <baseline-dist> &
PHUB_STUB_PORT=4180 PHUB_STUB_LATENCY_MS=120 node scripts/perf/stub-lk2-api.js apps/web/dist &
node scripts/perf/verify-run-isolation.js http://127.0.0.1:4180
node scripts/perf/measure-app-scenarios.js --baseline=http://127.0.0.1:4181 \
  --candidate=http://127.0.0.1:4180 --runs=7 --scenarios=home,profile,games,repeat,nav,background
```

## 9. Gaps and limits

- No installed Android/iOS measurement; the mobile WebView bundle is not the app.
- No API/PostgreSQL/Redis/Viva timing: no live/staging access, local Docker daemon unavailable. The
  server critical-path plan stays a plan.
- Background return measures when the refresh request leaves the client, not refreshed data display.
- The media conditional-GET change is verified at handler level only (#679).
- The games catalog latency is local (stub), not Viva/LK1.

## 10. Media and CSS status

- Media (#679): code, route tests and parser boundaries are in place; the contract gate remains
  **BLOCKED** on a release-owner decision, tracked separately in
  [lk2-media-cache-2026-11-17.md](lk2-media-cache-2026-11-17.md).
- CSS: measured and reverted; the experiment is closed. Details and screenshots are in
  [css-experiment-2026-11-18.md](css-experiment-2026-11-18.md).
