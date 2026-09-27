# Android local read storage

Owner: Android LK2. Implemented by `AndroidReadCache`, `AndroidReadCacheStore` and
`AndroidSessionEngine`; the web and iOS clients retain their existing behavior.

The local store is a disposable display cache, never the source of business state or authority.
It reuses existing PadlHub read contracts without a new dependency, server endpoint or database.
The first two consumers are HomeBase and the location directory. Extend the positive allowlist
only with a concrete screen, data-minimization review, retention rule and negative tests.

## Data and retention

| Data                                                                                                                                 | Fresh reuse | Hard maximum age            | Maximum response | After fresh lifetime                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------- | ---------------- | ------------------------------------------------------------------------- |
| Exact `GET /user/api/v1/{tenant}/home/base`                                                                                          | 30 seconds  | 15 minutes                  | 512 KiB          | Fetch live; transient-failure fallback may show the saved whole aggregate |
| Exact `GET /user/api/v1/{tenant}/locations`                                                                                          | 60 seconds  | 24 hours                    | 256 KiB          | Fetch live; transient-failure fallback may show the saved directory       |
| Own/other profiles, phone, balance, notifications, chats, bookings, history, recommendations, permissions, context, location details | None        | Not persisted in this store | N/A              | Existing live reads                                                       |
| OTP, access/refresh tokens, HTTP headers, correlation IDs, media, payment/booking commands                                           | None        | Not persisted in this store | N/A              | Existing session custody/network path                                     |

Only successful HTTP 200 JSON responses are candidates. Canonical paths have no query variants.
HomeBase must belong to the confirmed `viewerUserId`; unknown top-level fields, known credential
or financial field names, invalid UTF-8 and oversized bodies are rejected from persistence.
Whole responses replace the prior record; fields from different aggregate versions are never merged.
Server snapshot/source/freshness metadata remains intact. Home capabilities are display metadata;
cached data never authorizes a command. Location detail's `openNow`, address and phone are excluded.

There are at most two entries. The serialized plaintext envelope, including JSON escaping, is capped
at 1 MiB; AES-GCM adds 29 bytes. AtomicFile can temporarily retain a previous/write copy while an
update completes. The cache cannot accumulate historical versions, additional accounts or images.
Oversized writes discard the disposable cache instead of truncating records. Expired records are
removed on an authorized load/read/write; reads never advance `savedAt`. Hard-expired data is never
returned. A suspended/unopened app does not run a timed disk sweeper: encrypted bytes may remain
until the next authorized access, logout or app-data removal. This is a maximum usable age, not an
OS guarantee to delete bytes at a wall-clock deadline.

Within a process, age includes monotonic elapsed time, so moving the device clock backward cannot
extend a loaded entry. Future timestamps and monotonic-clock rollback are discarded. Across process
restarts, stored wall time is checked again after online session confirmation.

## Identity, encryption and cleanup

- A separate Android Keystore AES-256-GCM key encrypts one versioned AtomicFile in `noBackupFilesDir`.
  The existing manifest disables backup. Access JWTs stay in process memory; refresh credentials
  remain in their existing separate encrypted session record.
- AAD binds package, fixed API origin, configured tenant, cache schema, confirmed tenant UUID and
  user UUID. Canonical entry keys and all envelope contents are authenticated by the same GCM tag.
  File/key names use a scope hash, with no user ID or display text.
- Identity comes only from a validated HTTPS verify/refresh result: `user.id == context.userId`
  and both user/tenant identifiers must be PadlHub UUIDs. It is saved with the encrypted credential.
  A refresh cannot change the predecessor's known identity. An older 1.1 credential without identity
  remains restorable, but enables no cache access until a successful identity-bearing refresh.
- A cache read/write additionally requires the exact currently issued access bearer, unexpired
  monotonic access deadline (bounded by server expiry and the server's 3600-second maximum), matching
  saved identity, no refresh journal and no logout intent. No JavaScript storage write/read API exists.
  Cache writes use only native network responses; a generation fence rejects obsolete work.
- On logout, the app hides account UI immediately. Native code records the durable logout intent,
  disables cache access and erases its Keystore key before network revocation. The session's existing
  recovery journal remains intact until revocation is confirmed. Failed key deletion preserves the
  logout marker and blocks successful logout/API use until retry. Once the key is erased, leftover
  ciphertext is unreadable; creating a replacement key requires orphan-file cleanup first.
- Cache erasure has its own non-secret durable purge marker, including erasure triggered by an
  API 401. Key and ciphertext deletion are attempted independently. A subsequent process must
  finish a pending purge before reading/writing a cache, even after successful session refresh.
- API 401 clears all cached data and the in-memory cache grant, while retaining the refresh credential
  for the SDK's existing refresh flow. Refresh 401/session expiry also clear credentials. Resource
  403/404 removes its exact cache entry and returns the denial. A new account cannot decrypt or reuse
  the preceding account's data. Missing, corrupt, incompatible or invalidated cache becomes a miss;
  a successful live response remains usable even if its cache write fails.

Fresh-cache reuse intentionally delays seeing a remote content/revocation change for at most
30/60 seconds within the active access grant. It never exposes newly fetched data or accepts commands
under an offline grant. Session/context reads always go to the server.

## Failure behavior and interface

After the fresh lifetime, first try the server. Only `NATIVE_NETWORK_UNAVAILABLE` or HTTP
502/503/504 may fall back to a still-valid saved record. Never fall back on TLS/certificate errors,
redirects, malformed responses, auth/storage failures or other HTTP statuses (including 429).
The active access deadline and hard record age are rechecked after the network attempt.

Native bridge metadata carries `fresh-cache`/`stale` and `savedAt` separately from HTTP headers.
The mobile shell shows an accessible notice naming each stale section and its fetch date/time.
A successful same-section response clears its notice; an unrelated response does not. The notice
also clears when that read fails without fallback: the mobile shell remounts the shared App to
discard its previously retained screen data, while keeping the authenticated gateway. Initial
failures do not loop through remounts; late observations from the discarded generation are ignored.
Logout/remount clears all UI state. The existing Home polling refreshes at 30-second intervals;
directory reads occur on entry.

This increment uses fresh-cache-first and then network-first with bounded fallback. It does not
implement stale-while-revalidate, background OS synchronization, parallel native requests, media
downloads, offline commands or offline cold-start login. After process death, the saved session must
first refresh online before any snapshot becomes accessible. An APK update keeps schema-compatible
copies subject to the same identity/age rules; unknown envelope schema is discarded. Future schema
changes must also retire obsolete cache keys/files, without changing credential custody.

## Verification

`AndroidReadCacheTest` uses fake senders/clocks and synthetic identities, plus the emulator's real
Keystore. It covers fresh/hard TTL edges, non-sliding age, process recreation, exact bearer and
monotonic access expiry, refresh/account mismatch, pending journal, logout/purge failure, 401 versus
403/404, TLS/HTTP failure classification, allowlist/bounds, malformed storage, ciphertext/AAD and a
crash between key deletion and file cleanup. `native-api-fetch.test.ts` checks metadata provenance
and late observations after logout; `MobileCacheNotice.test.tsx` checks scoped accessible warnings.
Run the full repository gate and native instrumentation for this privacy/session boundary. Emulator
synthetic checks do not prove real-device login, production reachability or provider behavior.
