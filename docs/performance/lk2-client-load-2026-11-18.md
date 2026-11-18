# LK2 client load: measured scenarios, limits, and the next step

Date: 2026-11-18. Branch: codex/lk2-performance-client, split out of PR #670.
Companion API change: codex/lk2-performance-media (conditional GET for public media, PR #679).

## Evidence level

Everything here is **LOCAL** evidence: synthetic, reproducible client timings of the built web shell
against scripts/perf/stub-lk2-api.js with fixtures derived from the UI tests. It is

- **not** a user measurement,
- **not** STAGING or PRODUCTION evidence,
- **not** a run of the installed Android application. The mobile bundle in Chromium is a WebView-asset
  proxy at best and is labelled that way where it appears.

The earlier auth/shell numbers from PR #670 were renamed precisely and are kept as a **preliminary
signal** (5 cold runs is not a p95): web shell 1927/1964 -> 1666/1720 ms; mobile WebView assets in
Chromium 2071/2089 -> 1860/1891 ms.

## The stand (2026-11-18 revision)

The scenario harness in this revision addresses the stand defects found in review:

| Was                                                                          | Now                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Mixed clocks: Node Date.now() for requests, performance.now() for the marker | **One clock**: page timeOrigin; waterfall and marker share the document timeline                                       |
| Marker could flip on a shared header before the screen's own data arrived    | Marker = DOM signal **and** the read that owns it completed (games: cards rendered)                                    |
| Stub returned no stations, so the builds compared different station data     | locations fixture exposes exactly the station id/name used by the game cards                                           |
| Games cards unmeasurable (catalog is a read job)                             | Stub implements the **read-job protocol locally** (start -> complete with a local EVENT_CATALOG page); no Viva, no LK1 |
| One byte number mixed API payload and static shell                           | apiPayloadBytes vs networkTransferBytes / staticTransferBytes (resource timings)                                       |
| No per-request detail                                                        | waterfall: per-endpoint start/end/bytes on the same clock                                                              |
| No style data                                                                | --css-coverage reports used vs total CSS bytes; --trace=<file> writes a Chrome trace                                   |

Conditions, identical before and after: headless Chrome, 412x915, CPU throttled 4x, network
1.6 Mbit/s down / 750 kbit/s up with 150 ms RTT, HTTP cache cleared before every cold run, same
fixtures, same stub latency (120 ms per read), same machine, **7 runs per scenario**. Raw results:

- [scenarios-before](measurements/scenarios-before-20261118.json) / [scenarios-after](measurements/scenarios-after-20261118.json)
- [summary](measurements/scenarios-summary-20261118.json)
- [CSS coverage before](measurements/css-coverage-before-20261118.json) / [after](measurements/css-coverage-after-20261118.json)
- [Home trace summary](measurements/home-trace-summary-20261118.json) (raw trace regenerable with --trace)

## What each scenario measures

| Scenario    | Stop condition                                                                   |
| ----------- | -------------------------------------------------------------------------------- |
| home        | .fh-bottom-nav present, a heading with the viewer name, and /home/base completed |
| profile     | #profile-name present, the balance block visible, and a profile read completed   |
| profile-nav | same, after an in-app pushState to /profile from a loaded Home                   |
| games       | at least one .game-card rendered from the read-job catalog                       |
| repeat      | Home loaded once to warm the cache, then the measured Home open                  |
| background  | a /home/base request leaving the client after a focus event                      |

## Results (7 runs each, p50/p95)

| Scenario                   | Before first data | After first data | API payload p50 | Network transfer p50 |
| -------------------------- | ----------------- | ---------------- | --------------- | -------------------- |
| Home                       | 4365 / 10266 ms   | 4569 / 5644 ms   | 3723 -> 4096 B  | 302 373 -> 267 933 B |
| Profile cold               | 4081 / 5519 ms    | 4490 / 5758 ms   | 5043 -> 4168 B  | 336 673 -> 302 422 B |
| Profile from Home          | 3393 / 3571 ms    | 2817 / 6840 ms   | 5917 -> 2281 B  | 36 726 -> 33 234 B   |
| Games until cards          | 3836 / 4061 ms    | 3808 / 7271 ms   | 2913 -> 2913 B  | 321 029 -> 308 222 B |
| Repeat open                | 904 / 1547 ms     | 909 / 1752 ms    | 2953 -> 4878 B  | 9254 -> 9803 B       |
| Background refresh request | 8 / 17 ms         | 8 / 13 ms        | -               | -                    |

### What these numbers do and do not show

- **No confirmed first-screen win.** For Home, Profile and Games the p50/p95 differences are inside
  the run-to-run spread (before Home p95 was 10 266 ms, after 5 644 ms; the p50 moved the other way by
  4%). The honest statement is: this batch reduced bytes, not first-data time in this synthetic
  profile.
- **Bytes did fall where expected.** Static transfer on Home 297 147 -> 263 380 B (-11%), consistent
  with the bundle closure (238 454 -> 193 185 B gzip). Profile API payload fell 5043 -> 4168 B because
  the 50-game read is gone; the in-app profile navigation moved 5917 -> 2281 B of API payload.
- **The repeat open and the background refresh are unchanged** at this sample size.
- **API payload is a small part of the network.** On Home the API is ~3.7 KB against ~268 KB of shell
  transfer, so read-side tuning alone cannot move first paint much.
- **Main-thread work is not the bottleneck at this throttle.** The captured Home trace has one
  191 ms task above 50 ms; boot time is dominated by downloading and parsing the shell.
- **CSS is almost entirely unused at first paint.** Of the single eager stylesheet, Home uses
  ~16.0 of 250.7 KB (6.4%), Profile ~25.2 of 255.8 KB (9.9%), Games ~16.0 of 239.8 KB (6.7%).
  Identical before and after, because this batch did not touch the stylesheet.

## Client safety checks

- DeferredScreen: a parent re-render does not remount the loaded screen; a rejected chunk load
  reaches an error boundary. The existing vite:preloadError reload-once handler still covers a stale
  chunk.
- Deferred reads: none starts after unmount or a session change (shouldStart, now also on the friends
  read); a focus refresh joins the pending inbox read.
- Command invalidation: read-coalescer.invalidate(prefix) drops pending entries after
  markNotificationsRead (single and all), markConversationRead and friend-request accept/decline, so
  the post-command read is never answered by a request that started before the command. Keys are
  scoped by tenant + user + parameters and cleared on session change.
- CREATE PR #669: no file overlap; its five web files applied on top of this branch left App.test.tsx
  at 113/113 including the lazy quarter-panel mount. Its own CREATE suites fail identically on
  pristine origin/main in this Node 26 + jsdom environment (39/39), so the failures are
  environmental, not caused by the lazy boundary.

## Gaps

- No installed-Android measurement and no API/PostgreSQL/Redis/Viva timing. The server critical-path
  plan and the exact missing evidence are below: a running API with a disposable local database
  (needs explicit authority) or STAGING read access, plus VIVA_MODE=mock.
- The games read-job protocol is reproduced locally with a fixed page; it does not measure Viva/LK1
  latency, only the client's handling of that protocol.

## Next step with the greatest confirmed effect

Evidence points at the **eager shell**, not at reads:

1. static transfer dominates the network (98% of Home bytes) and the captured trace shows no
   main-thread hotspot above ~200 ms;
2. the single global stylesheet is 6-10% used on the first screens and is parsed on every launch.

So the next optimization is to **split the global stylesheet**: keep shell/auth/Home styles in the
initial CSS and move chats, communities, games catalog, profile-v2 and detail styles into the chunks
they belong to (the lazy screens already carry their own CSS where it was extracted). Acceptance is
measured on the same stand: lowered static transfer and first-data time on Home/Games without a flash
of unstyled content and with the existing visual tests still green.

## Server critical path: plan and missing evidence

Intended measurement for one cold open: client mark when the refresh request starts, then each
/home/base, /profile and catalog call resolves (already in the waterfall); API request duration with
internal spans for the same correlation id (handler, DB queries with EXPLAIN (ANALYZE, BUFFERS),
Redis calls, LK1/Viva round trips); client mark when the screen applies the data. Missing: a running
API with a disposable local database or STAGING read access, plus VIVA_MODE=mock. Until then no
server p95 claim is made.

## Android persistent profile/games cache: follow-up task definition

Separate task after a device/emulator measurement. Fixed in advance: tenant+user cache keys; fresh
window plus a hard maximum age; an entry is dropped when the session is revoked or logout runs; a
cached price, permission, free-seat count or entitlement is display-only and never authorizes a
commercial operation; bounded byte budget with least-recently-used eviction.
