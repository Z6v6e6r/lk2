# LK2 client load: split client changes and what was actually measured

Date: 2026-11-17. Branch: `codex/lk2-performance-client`, split out of PR #670.
Companion API change: `codex/lk2-performance-media` (conditional GET for public media).

## Evidence level and honest metric names

Everything below is **LOCAL** evidence: synthetic, reproducible client timings of the built web
shell against `scripts/perf/stub-lk2-api.js` with fixtures extracted from the UI tests. It is

- **not** a user measurement,
- **not** STAGING or PRODUCTION evidence,
- **not** a run of the installed Android application. The mobile bundle in Chromium is at most a
  WebView-asset proxy and is labelled that way where it appears.

The numbers in the earlier #670 report described the **auth/shell screen** (the login heading or
the mobile login gate) on a page with no API. They are kept below, renamed precisely, and marked as
a preliminary signal: five cold runs are not a reliable p95.

## What each scenario measures

| Scenario           | Marker that stops the clock                                | What it is                                                                     |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `home`             | a heading whose text is the viewer's name                  | cold open with a valid session, until **filled Home** (dashboard data applied) |
| `profile`          | the booking-preferences section or a heading with the name | cold direct entry, until **profile main data**                                 |
| `profile-nav`      | same marker                                                | Home already open, then in-app navigation to the profile, until main data      |
| `games`            | the discovery header text                                  | /games **screen shell** only — see the gap below                               |
| `repeat`           | the Home marker                                            | first open warms the HTTP cache; the measured sample is the **repeat open**    |
| `background`       | a new `/home/base` request leaving the client              | return from the background (focus), until the **refresh request** starts       |
| shell (old report) | auth heading / mobile login gate                           | **auth/shell** first screen without any API                                    |

Every sample also records the request timeline (when each read left the client), the request count
and the response bytes of that run.

## Reproducing it

```
npm run build -w @phub/web
node scripts/perf/extract-fixtures.js                 # fixtures from apps/web/src/App.test.tsx
PHUB_STUB_PORT=4180 PHUB_STUB_LATENCY_MS=120 \
  node scripts/perf/stub-lk2-api.js apps/web/dist     # shell + fixture API, 120 ms per read
node scripts/perf/measure-app-scenarios.js http://127.0.0.1:4180/ --runs=7
```

Conditions, identical before and after: headless Chrome, 412×915, CPU throttled 4×, network
1.6 Mbit/s down / 750 kbit/s up with 150 ms RTT, HTTP cache cleared before every cold run, same
fixtures, same stub latency, same machine. Raw results:
[measurements/scenarios-before-20261117.json](measurements/scenarios-before-20261117.json),
[measurements/scenarios-after-20261117.json](measurements/scenarios-after-20261117.json).

## Baseline → after (7 runs each, p50/p95)

| Scenario                            | Before p50/p95 | After p50/p95  | Before req / bytes (p50) | After req / bytes (p50) |
| ----------------------------------- | -------------- | -------------- | ------------------------ | ----------------------- |
| Home, filled                        | 4788 / 5787 ms | 4440 / 5558 ms | 10 / 3444 B              | 7 / 2953 B              |
| Profile, cold direct entry          | 4724 / 5665 ms | 4528 / 4809 ms | 12 / 5043 B              | 12 / 3974 B             |
| Profile, in-app from Home           | 3348 / 3375 ms | 1457 / 3506 ms | 7 / 3743 B               | 9 / 3153 B              |
| Games, screen shell                 | 3280 / 4570 ms | 3248 / 4384 ms | 1 / 430 B                | 1 / 430 B               |
| Repeat open, filled Home            | 647 / 1863 ms  | 772 / 1636 ms  | 9 / 3195 B               | 9 / 3395 B              |
| Background return → refresh request | 11 / 29 ms     | 6 / 19 ms      | —                        | —                       |

Preliminary shell signal from the earlier report (5 cold runs, auth/shell screen, different harness):

| Shell                                   | Before p50/p95 | After p50/p95  |
| --------------------------------------- | -------------- | -------------- |
| Web auth/shell first screen             | 1927 / 1964 ms | 1666 / 1720 ms |
| Mobile WebView shell assets in Chromium | 2071 / 2089 ms | 1860 / 1891 ms |

### How to read this

- The first authorized screen improves by **~7% p50 / ~4% p95** on Home, and the number of reads that
  race the first data drops from 10 to 7 because badge reads start after it.
- The profile route no longer reads 50 public games to learn station names: the payload of that read
  falls from a 50-card page to the locations list (**p50 response bytes 5043 → 3974, −21%**), and the
  cold-entry p95 falls **15%**.
- The in-app profile navigation p50 improvement (3348 → 1457 ms) is large but its p95 is worse
  (3506 vs 3375 ms) and the spread is wide; treat it as unstable, not as a proven win.
- Repeat open and background refresh are indistinguishable from noise at this sample size.
- **No absolute number here is a user timing.** The ~4.5 s cold boot is dominated by a 4× CPU
  throttle and a slow link downloading the shell; the deltas, not the absolute values, are the
  result.

## What changed in the client

1. **Lazy screens.** `GameDetailView`, `NativeGames`, `NativeGameJoin`, `NativeSelfLeave`,
   `NativeGameChat`, `TournamentChatPage`, `QuarterCreatePanel`, `MonthlyPurchasePanel` are loaded
   on demand inside their own Suspense boundary (`DeferredScreen`).
2. **Startup read priority.** Badge reads on Home and the secondary blocks of the profile route
   start from an idle callback instead of racing the first data. `deferRead` accepts a
   `shouldStart` check, so a read is never sent after the screen unmounted or the session changed.
3. **One in-flight read per key.** `read-coalescer.ts` shares a pending notifications, friend-request
   or conversations read between the effects that ask for it at the same moment; keys carry the
   principal and the request parameters, the entry exists only while the request is pending, and it
   is cleared when the session changes or a notification command refreshes the inbox.
4. **Stations from the stations read.** Booking preferences now build the station list from
   `listLocations()` instead of the last 50 public game cards (same station ids, smaller payload).
   Commercial checks (price, permissions, free seats) are untouched: they still come from the
   canonical reads.

**The 2-second idle ceiling is a scheduling limit, not a guarantee that data appears within two
seconds.** Under a slow network or a busy main thread the callback and the read can take longer; the
only guarantee is that the read is attempted after the first screen instead of competing with it.

## Client safety checks

- **Lazy screens keep their state.** `DeferredScreen` has a focused test proving that a parent
  re-render does not remount the loaded screen (the counter keeps its value) and that a rejected
  chunk load reaches the nearest error boundary instead of a blank screen. The app also keeps its
  existing `vite:preloadError` reload-once handler for a stale chunk from a previous release.
- **CREATE/JOIN/LEAVE and purchase screens.** No command path changed; only the module load is
  deferred. The existing `native quarter entry mounts only the bounded subscription form` test still
  passes through the lazy boundary, and the CREATE PR #669 was integrated locally for a verification
  run (see below).
- **Deferred reads.** Tests cover: the read is not started after unmount (`shouldStart`), a late
  response cannot touch a screen that is gone, the coalescer is cleared when the session ends so two
  accounts never share an entry, and a focus refresh joins the pending inbox read instead of issuing
  a second one.
- **Errors.** A deferred read keeps the existing per-block failure handling: an error leaves the
  block's own error state and never blocks the first screen.

### Coordination with CREATE PR #669

#669 changes `QuarterCreatePanel`'s waiting/recovery/card-transition presentation and its tests.
File overlap with this branch: none (this branch touches `App.tsx` and new modules; #669 touches
`QuarterCreatePanel.tsx/css` and its tests). Integration check performed locally: #669's source and
tests applied on top of this branch, then `QuarterCreatePanel.test.tsx`, `CreateGamePage.test.tsx`
and `App.test.tsx` run together. Result recorded in the PR description. Recommended merge order:
either order is file-safe; when both are on `main`, re-run those three suites once as the
integration gate.

## Gaps that this report does not close

- **Game cards on /games are not measured.** That route builds its cards from the client-assisted
  read job (`POST /booking-screen-read-jobs` + `.../complete`), which needs an LK1/Viva payload the
  read-only stub does not produce. The `games` row above is the screen shell only.
- **No installed Android measurement.** No device or emulator session was available; the mobile row
  in the preliminary table is the WebView asset bundle in Chromium.
- **No API/PostgreSQL/Redis/Viva timings.** No live or STAGING access in this task and the local
  Docker daemon is unavailable, so the server half of the critical path is planned, not measured
  (below).

## Server critical path: measurement plan and missing evidence

Intended measurement, end to end for one cold open with a valid session:

1. client mark when the refresh request starts, then when each of `/home/base`, `/profile`,
   `/games` resolves (already visible in the sample request timeline);
2. API request duration and internal spans for the same correlation id: route handler, database
   queries (with `EXPLAIN (ANALYZE, BUFFERS)` for the top three), Redis calls, and any LK1/Viva
   round trip;
3. provider and database counters during the run (rows scanned, cache hits/misses, provider latency);
4. client mark when the screen applies the data.

Missing evidence, stated as such: a running API with a disposable local database (needs explicit
authority to create one) or STAGING read access, plus `VIVA_MODE=mock` for provider paths. Until
then, no server p95 claim is made and no cause is assumed.

## Android persistent profile/games cache: follow-up task definition (not implemented)

A separate task after a device/emulator measurement. Required properties, fixed in advance:

- **Account isolation:** the cache key includes tenant and user; a different principal never reads
  another account's entry, and a session change wipes the in-memory index first.
- **Freshness:** fresh window for display, hard maximum after which the entry is not shown at all;
  an entry is marked as cached in the UI while it is displayed.
- **Logout and revocation:** logout erases the store (already the behaviour for the existing
  `AndroidReadCache`); a revoked session or a `401` must not resurrect cached data.
- **Never authorization:** cached prices, permissions, free seats or entitlements are display only.
  Every commercial operation still reads the canonical server state and re-checks price, rights and
  capacity at command time.
- **Bounded size and eviction:** fixed byte budget with least-recently-used eviction.

## Next step with the greatest confirmed effect

The largest measured client-side effect left on the table is the **repeat open**, which is still
network-bound for Home data. The next single step with the best evidence-to-risk ratio is a small,
bounded read snapshot for exactly two models — the viewer's Home base and the first page of games —
scoped by tenant and user, cleared on logout, with a visible cached marker and a hard maximum age,
and never used as authorization. It must be measured on a device/emulator before it is built, and it
belongs in the Android cache task above rather than in this PR.
