# LK2 load performance — audit and first optimization batch

Date: 2026-11-17. Branch: `codex/lk2-performance` on top of `origin/main` `ffb88cb8656a57a9580194f69e8ad72a136b59b8`.

## Evidence level and scope

All numbers below are **LOCAL** evidence: synthetic, reproducible measurements of the built client
in headless Chromium on this workstation. They are **not** user measurements, and they are not
STAGING or PRODUCTION evidence.

What this session could not measure, and why:

- no live API access (no PRODUCTION/STAGING credentials in this task), and the local Docker daemon
  is unavailable, so API, PostgreSQL, Redis and Viva timings could not be sampled;
- no Android device or emulator session, so Android numbers are the mobile WebView bundle played by
  Chromium with the same throttling profile; `AndroidReadCache` behaviour is analysed from source;
- the preview server (`vite preview`) does not send the production nginx cache headers, so "warm"
  runs still re-download assets. Production marks `/assets/*` `immutable` for a year, so real warm
  opens are faster than the warm figures below.

## How the measurements were produced

```
npm run build -w @phub/web
node scripts/perf/bundle-critical-path.mjs apps/web/dist       # static first-paint closure
npx vite preview -w @phub/web                                  # serve the built shell
node scripts/perf/measure-web-first-screen.mjs http://127.0.0.1:4173/ --runs=10
```

`scripts/perf/measure-web-first-screen.mjs` drives real Chrome over the DevTools protocol:
412x915 viewport, CPU throttled 4x, network limited to 1.6 Mbit/s down / 750 kbit/s up with 150 ms
RTT ("slow 4G"), cold run clears the HTTP cache, the following runs reuse it. It reports the time to
the first useful screen (the auth screen heading or the mobile login gate), LCP, DOMContentLoaded,
request count and encoded transfer bytes. The mobile column uses `apps/mobile` (Capacitor WebView
assets, same React tree).

## Baseline before the change

| Shell        | Run            | First useful screen | LCP        | DCL        | Requests | Transfer  | JS        | CSS      |
| ------------ | -------------- | ------------------- | ---------- | ---------- | -------- | --------- | --------- | -------- |
| Web          | cold           | 1880 ms             | 1720 ms    | 1639 ms    | 22       | 248 012 B | 96 564 B  | 44 814 B |
| Web          | warm (p50/p95) | 1002/1017 ms        | 840/852 ms | 757/771 ms | 22       | 248 012 B | 96 564 B  | 44 814 B |
| Mobile shell | cold           | 2088 ms             | 1912 ms    | 703 ms     | 12       | 258 944 B | 207 290 B | 43 993 B |
| Mobile shell | warm (p50)     | 986 ms              | 848 ms     | 395 ms     | 11       | 254 057 B | 207 290 B | 43 993 B |

Static first-paint closure of the web build: **14 eager JS/CSS files**, 671 093 B of JS
(195 063 B gzip), 242 397 B of CSS (43 391 B gzip) — 238 454 B gzip in total, of which the entry
chunk alone was 321 684 B. The mobile startup shell was 966 160 B raw / 250 401 B gzip over 9
requests.

## Findings ranked by user impact

1. **The entry chunk contained screens nobody opens on launch.** `App.tsx` statically imported the
   game-detail view, tournament chat, native join/leave/chat, quarter-create and monthly-purchase
   panels, so every launch parsed them on a mid-range Android CPU.
2. **Unchanged images were re-downloaded in full.** `/public/api/v1/media/profile-photos/...` and
   `/public/api/v1/media/community-logos/...` send `Cache-Control: public, max-age=300` and an
   `ETag`, but the API never answered `If-None-Match`. Every avatar and logo older than five
   minutes therefore cost a full WebP body on the next screen, repeatedly.
3. **Startup read fan-out competed with the content of the first screen.** On the profile route the
   first paint issued ten reads at once — including `listPublicGames({ availability:
'INCLUDE_FULL', limit: 50 })` that exists only to build a station filter — while the profile card
   waited behind them. On Home, three badge reads (notifications, friend requests, unread chats)
   were racing the dashboard read.
4. **No persistent read snapshot for profile and games on Android.** `AndroidReadCache` covers only
   `/home/base` (fresh 30 s, max 15 min) and `/locations`; profile and game lists are always read
   online, so a repeat open cannot show them before the network answers.
5. **Media URLs are stable per user, not per content version.** `delivery_id` is generated once per
   user (`integration.user_profile_photo_sync`), so `immutable` caching is not safe yet; conditional
   GET is the correct fix without a data-model change.
6. **Server-side reads.** Game-card queries are batched (one projection query, one profile batch);
   the game list is served with `Cache-Control: no-store`; JSON compression is not enabled in the
   API process but the Timeweb Caddy front sends `encode zstd gzip`; polling stays at 15 s
   (notifications), 30 s (home) and 60 s (unread chats).

## Optimizations implemented in this batch

### 1. Conditional GET (304) for public media

`apps/api/src/media/conditional-media-get.ts` implements weak `If-None-Match` comparison
(RFC 9110 §13.1.2); the profile-photo and community-logo routes now answer a matching tag with a
bodyless `304` that keeps `ETag` and `Cache-Control`, and still stream the object when the tag
changed. The public contract documents the added response and header
(`contracts/openapi/public/v1/openapi.yaml`).

Effect: an unchanged avatar/logo costs headers instead of image bytes on every revalidation, which
is what a returning WebView does for every image it shows. Changed photos still use the same URL,
so the 300 s freshness plus ETag revalidation remains the correctness guarantee — no stale image is
served when the stored object changes.

### 2. Entry-chunk split

Eight components that are only reachable after a tap are now `React.lazy` with their own Suspense
boundary (`DeferredScreen`): `GameDetailView`, `NativeGames`, `NativeGameJoin`,
`NativeSelfLeave`, `NativeGameChat`, `TournamentChatPage`, `QuarterCreatePanel`,
`MonthlyPurchasePanel`.

Effect (web build): entry chunk 321 684 B -> 281 320 B; first-paint closure 671 093 B -> 512 725 B
of JS and 14 -> 13 eager files. Effect (mobile shell): 966 160 B -> 801 926 B raw,
250 401 B -> 207 776 B gzip (17% less to download and compile before the first screen).

### 3. Startup read prioritization

`apps/web/src/deferred-idle.ts` adds `runWhenIdle` and `deferRead`. Badge reads on Home
(notifications, friend requests, unread chats) and the secondary blocks of the profile route
(communities, subscriptions dashboard, friends, both friend-request lists, notifications, and the
50-game station lookup) now start when the browser is idle (with a 2 s ceiling) instead of competing
with the first screen. Nothing is skipped: the same reads still run on the same screen, and focus /
interval refreshes stay immediate.

First paint request counts: profile route 10 -> 3 (profile card, privacy settings, booking
preferences); Home unchanged for the dashboard read, minus three badge reads that no longer race it.

## After the change

| Shell        | Run            | First useful screen                       | LCP                | DCL              | Requests | Transfer           | JS                 | CSS      |
| ------------ | -------------- | ----------------------------------------- | ------------------ | ---------------- | -------- | ------------------ | ------------------ | -------- |
| Web          | cold           | 1662 ms (-11.6%)                          | 1500 ms (-12.8%)   | 1408 ms (-14.1%) | 18 (-4)  | 202 128 B (-18.5%) | 86 355 B           | 42 743 B |
| Web          | warm (p50/p95) | 978/996 ms (-2.4%)                        | 804/836 ms (-4.3%) | 730/740 ms       | 18 (-4)  | 202 128 B (-18.5%) | 86 355 B           | 42 743 B |
| Mobile shell | cold           | 1871 ms (-10.4%)                          | 1704 ms (-10.9%)   | 692 ms           | 13 (+1)  | 216 232 B (-16.5%) | 165 715 B (-20.1%) | 42 856 B |
| Mobile shell | warm (p50)     | 1016 ms (+3.0%, within run-to-run spread) | 860 ms             | 392 ms           | 12       | 211 345 B (-16.8%) | 165 715 B          | 42 856 B |

Static closure after: **13 eager files**, 512 725 B JS (151 328 B gzip) + 236 173 B CSS
(41 677 B gzip) = 193 005 B gzip (-19.1%).

The warm figures barely move because the preview server re-sends every asset on each run; the
payload reduction (16-19%) is what warm opens will feel once nginx serves `/assets/*` as
`immutable`. Deferred reads are invisible in this harness by design: it has no API, so the effect
is proven by the request-order tests, not by wall-clock here.

## Remaining problems

- **Repeat open still cannot show a cached profile or game list on Android.**
  `AndroidReadCache.rules` deliberately admits only `/home/base` and `/locations`. Extending it to
  profile and the first game page is the next largest win, but it changes native session cache
  policy and needs the Java instrumentation suite on a device/emulator.
- **No content version in media URLs.** Adding e.g. the content SHA to the delivery path would allow
  `immutable` caching and remove even the conditional round trip.
- **No API/DB/Redis measurement.** p95 for the read endpoints, index usage, Redis hit rate and Viva
  round trips still need a running stack (compose with `VIVA_MODE=mock`) or STAGING read access.
- **Duplicated and oversized reads.** `listNotifications` is issued by four effects,
  `listProfileFriendRequests` by three; the profile route pulls 50 public games only to name
  stations. A small read-coalescing layer and a station read would remove both.
- **Android HTTP cache size** is left to Chromium defaults; a bounded app-level avatar cache is only
  worth building if device traces show eviction.

## Risks and rollout

- The split adds one chunk request when a person first opens game detail, tournament chat or a
  purchase panel; the Suspense fallback shows the existing loading copy. Rollback is a revert.
- Deferred reads can appear up to 2 s later (or on the next focus/interval tick). They are counts and
  secondary blocks, never the profile card, game list, prices or entitlements.
- The 304 response depends on the stored object's ETag; objects without one behave exactly as
  before. No schema, data or authorization change is involved.
- Suggested order: Web lane first (the shell change is storage-free), then the next Android bundle;
  watch `/public/api/v1/media/*` 304 share and error rate after release.
