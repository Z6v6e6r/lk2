# LK2 client load — measurement report (2026-11-18)

Branch: `codex/lk2-performance-client` (PR #678), split out of #670. Companion API change:
`codex/lk2-performance-media` (PR #679).

## 1. What is proven

On the repaired stand, with 7 alternating valid runs per variant and scenario:

- **Home**: first useful screen 2805 → 2643 ms median (**-5.8%**), data applied 2136 → 1870 ms
  (**-12.5%**), total network +2.6% (the next-screen prefetch runs after the first data arrives).
- **Home → Games transition**: 2420 → 1884 ms median (**-22.1%**); the gamified transition window
  transfers no JS because the games chunk is warmed after the first screen.
- **Profile**: 6033 → 5990 ms (parity), API payload -12.1%, total network -10.1% (the 50-game read is
  replaced by the locations read).
- **Games**: parity (+0.8%), total network -4.0%.
- **Repeat open**: parity this series (-2.7%).
- **Background return**: the refresh request leaves the client within 1-2 ms of the focus event in
  both variants; this measures request scheduling, not data refresh completion (see gaps).

Byte effects are reported separately from time and are not presented as speed. CSS was measured in a
separate experiment and **reverted** — see [css-experiment-2026-11-18.md](css-experiment-2026-11-18.md).

The absolute values describe a synthetic API and a throttled headless browser. They are LOCAL
evidence, not user measurements, not STAGING, and not the installed Android application.

## 2. Frozen comparison inputs

| Item                       | Value                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline                   | `origin/main` worktree at `adfb7d4c76fc742d6d286eeca990de07dd0b5431`, built `apps/web` (production build)       |
| Candidate                  | PR #678 head (see the PR for the exact SHA), same build command                                                 |
| Variants                   | baseline = plain main; candidate = #678 only; no media branch, no server change                                 |
| Browser                    | Chrome/157.0.8103.79, headless                                                                                  |
| Stand                      | `scripts/perf/measure-app-scenarios.js` (harness `scenario-stand-2026-11-18`)                                   |
| Viewport                   | 412×915, device scale 2.625 (screenshots additionally at 390 and 1280 wide)                                     |
| CPU                        | 4× throttle                                                                                                     |
| Network                    | 1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT                                                                      |
| Stub API                   | `scripts/perf/stub-lk2-api.js`, fixed 120 ms per read, fixtures from `apps/web/src/App.test.tsx`                |
| Runs                       | 7 repetitions per variant and scenario, alternating variant order                                               |
| Session                    | one synthetic session restored through `/auth/session/refresh`; same account and tenant in every run            |
| Cache, cold scenario       | `Network.clearBrowserCache` before every run; no Service Worker controls pages; no application-level data cache |
| Cache, repeat scenario     | one full cold Home load, then the measured open with the HTTP cache kept                                        |
| Cache, transition scenario | cache cleared, Home loaded, 1 s settle, then the in-app action; the clock starts at the action                  |

Raw data: [series-final JSON](measurements/series-final-20261118.json),
[series-final CSV](measurements/series-final-20261118.csv),
[CSS series JSON](measurements/series-css-20261118.json),
[CSS series CSV](measurements/series-css-20261118.csv),
[CSS coverage](measurements/css-coverage-20261118.json),
[run isolation proof](measurements/run-isolation-20261118.txt).

Reproduce with:

```
npm run build -w @phub/web
PHUB_STUB_PORT=4181 PHUB_STUB_LATENCY_MS=120 node scripts/perf/stub-lk2-api.js <baseline-dist> &
PHUB_STUB_PORT=4180 PHUB_STUB_LATENCY_MS=120 node scripts/perf/stub-lk2-api.js apps/web/dist &
node scripts/perf/verify-run-isolation.js http://127.0.0.1:4180
node scripts/perf/measure-app-scenarios.js --baseline=http://127.0.0.1:4181 \
  --candidate=http://127.0.0.1:4180 --runs=7 --scenarios=home,profile,games,repeat,nav,background
```

## 3. The stand: one clock, typed markers, isolated runs

**One clock.** Every duration in the output is page time. For a document navigation the origin is the
navigation entry (`startTime` 0); for the in-app transition it is `window.__PHUB_NAV_START`, captured
in the page at the moment of the action. Request, marker and paint times all come from
`performance.getEntriesByType(...)`/`performance.now()` on that timeline. Node wall clock appears only
in run bookkeeping (`wallClockStartedAt`) and is never used in a duration.

**Markers** (each fires once per run; the clock stops on the double `requestAnimationFrame` after the
DOM condition, so the value is a displayed time, not a state update):

| Metric                                                       | Condition                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `displayedMs` (Home)                                         | `.fh-bottom-nav` present, a heading with the viewer name, and `/home/base` completed |
| `displayedMs` (Profile)                                      | `#profile-name` present, the balance block visible, and a profile read completed     |
| `displayedMs` (Games)                                        | at least one `.game-card` rendered from the catalog read job                         |
| `displayedMs` (nav)                                          | same games condition, after the in-app transition, clock from the action mark        |
| `requiredDataAppliedMs`                                      | maximum `responseEnd` of the reads that own the marker, on the same clock            |
| `renderAfterDataMs`                                          | `displayedMs - requiredDataAppliedMs` (processing + paint after data)                |
| `sessionRestoreMs`, `firstApiRequestMs`, `lastApiResponseMs` | derived from the same resource entries                                               |
| `refreshRequestMs` (background)                              | focus event → next `/home/base` request start, page clock                            |

No application-level profile/games cache exists in this build, so a "cached data confirmed" marker
is not applicable and is not reported; the repeat scenario measures the HTTP-cache path instead.

**Run isolation.** Each run opens an epoch on the stub before navigation and freezes a snapshot after
the marker. A request is attributed to the run that was open when it **started**; a response that
arrives later stays in that run and cannot change a frozen snapshot. `verify-run-isolation.js` checks
this with direct HTTP (no browser):

- run A's slow request is in A's snapshot as in-flight; run B's snapshot contains only B's request;
- frozen snapshots are byte-identical after late completions; late completion is counted in A;
- the shared counters cannot be reset (`/__perf/reset` returns 409);
- **all 8 checks pass** — see [run-isolation-20261118.txt](measurements/run-isolation-20261118.txt).

The final series itself passed the same integrity gates: **84/84 attempts valid**, 0 page errors,
0 `displayed-before-data`, 0 late completions, all API responses 200, and every attempt that has a
frozen snapshot (70 of 84; the 14 background attempts do not take one) reports it unchanged.

## 4. Results (median [min..max], 7 valid runs each)

| Scenario     | metric          | baseline          | candidate         | delta                         |
| ------------ | --------------- | ----------------- | ----------------- | ----------------------------- |
| Home         | displayed       | 2805 [2696..3066] | 2643 [2569..2894] | **-162 ms / -5.8%**           |
| Home         | data applied    | 2136 [2077..2180] | 1870 [1842..2160] | -266 ms / -12.5%              |
| Home         | total network   | 302 847 B         | 310 816 B         | +2.6% (prefetch tail)         |
| Profile      | displayed       | 6033 [3797..6277] | 5990 [5480..6249] | -43 ms / -0.7%                |
| Profile      | data applied    | 5163 [2911..5466] | 5068 [4591..5211] | -95 ms / -1.8%                |
| Profile      | API payload     | 7217 B            | 6342 B            | **-12.1%**                    |
| Profile      | total network   | 336 673 B         | 302 546 B         | **-10.1%**                    |
| Games        | displayed       | 4376 [3029..4661] | 4411 [4368..5310] | +35 ms / +0.8% (parity)       |
| Repeat open  | displayed       | 2548 [2129..3239] | 2479 [2308..2796] | -69 ms / -2.7% (parity)       |
| Home → Games | displayed       | 2420 [765..3335]  | 1884 [903..2931]  | **-536 ms / -22.1%**          |
| Home → Games | window network  | 24 181 B          | 3 055 B           | -87.4% (chunk already warmed) |
| Background   | refresh request | 2 [1..2] ms       | 1 [1..2] ms       | floor measurement             |

Request counts (median): Home 10/10, Profile 13/13, Games 4/4, Repeat 10/9, transition 4/5.
API payload medians: Home 3549/3549 B, Games 2913/2913 B, transition 4657/4831 B.

### How to read the result

- **Acceleration is confirmed for Home and for the Home → Games transition.** Home applies data 12.5%
  earlier and displays 5.8% earlier; the transition is 22.1% faster at the median, and its window
  carries no JS because the games chunk is warmed after the first screen.
- **Profile is byte parity, not a time win**: payload and total network drop by 10-12%, time is flat
  within the spread (its ranges overlap heavily).
- **Games and repeat are parity at this sample size.** A single earlier series showed a larger repeat
  win; it is not carried here because it was produced before the final build.
- **The prefetch costs bytes**: Home total network rises 2.6% because the next screen's chunk is
  fetched after the first data. The first screen itself is not delayed (it is faster).
- Seven runs give a median and a range, not a p95. Slow values are kept in the CSV, not deleted.

## 5. What changed in the client (PR #678)

1. Lazy screens with their own Suspense boundary (game detail, tournament chat, native join/leave,
   quarter create, monthly purchase).
2. Startup priority for badge and secondary profile reads, with `shouldStart` so a read never starts
   after unmount or a session change.
3. A read coalescer that shares one pending read per tenant+user+parameters, invalidated after the
   commands that change those lists (notifications marked read, conversation read, friend request).
4. Booking preference stations from `listLocations()` instead of a 50-game read.
5. A post-paint prefetch of the games chunk, so the first tap does not pay the split cost.

## 6. Gaps and limits

- No installed Android or iOS measurement; the mobile WebView bundle is not the app.
- No API/PostgreSQL/Redis/Viva timing: no live or staging access in this task, and the local Docker
  daemon is unavailable. The server critical-path plan stays a plan.
- Background return measures when the refresh request leaves the client, not when refreshed data is
  displayed; a data-refresh marker would need a cache-aware identity signal that this build has not.
- The media conditional-GET change is verified at handler level only; no proxy/real-path 200/304
  measurement was possible without a running API.
- The games catalog read-job latency is local (stub), not Viva/LK1.

## 7. Media and CSS status

- Media (#679): code, route tests and parser boundaries are in place; the contract gate is BLOCKED on
  an owner decision and its CI has one unrelated infrastructure failure. Details are in
  [lk2-media-cache-2026-11-17.md](lk2-media-cache-2026-11-17.md).
- CSS: measured and reverted; details and screenshots are in
  [css-experiment-2026-11-18.md](css-experiment-2026-11-18.md).
