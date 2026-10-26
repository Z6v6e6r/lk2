# Android LK2: shared client and native session

Android reuses `apps/web/src/App.tsx`, existing product screens, navigation, assets and CSS.
The native shell uses the repository's Capacitor 8.4.1, Java, JDK 21 and Android SDK 36.

## Current increment

The existing Home, profile/level history, bookings/history, notifications and location screens
are enabled. Other sections display an explicit unavailable screen. This is an implementation
stage toward the complete LK2 product, not a reduced product scope. Android launcher icons use
the existing PadlHub mark; splash assets remain Capacitor placeholders.

Phone OTP uses the existing PadlHub challenge, verify, refresh and revoke endpoints. Android
requests go through `PadlHubAndroidSession` and system HTTPS, without browser fetch, shared cookie
jars, CORS changes or redirects. Provider access is limited to the fixed My Bookings exception
below. Native code independently validates the exact
origin, tenant, method, positive route list, headers and auth bodies. Only the bundled
`https://localhost` main document can use the modern Capacitor bridge; the legacy all-frame
JavaScript interface is removed, frames/objects are disallowed, bridge logging and WebView
remote debugging are disabled. External HTTPS navigation opens the system browser.

The refresh cookie never enters JavaScript. A package/origin/tenant-scoped Android Keystore
AES-GCM key encrypts one atomic record in `noBackupFilesDir`. The record contains the credential,
expiry and refresh/revocation journals. A separate non-secret atomic logout intent survives a
failed encrypted-record write. Access JWTs remain in process memory (JS and native cache guard).
Refresh journals precede the
network write and replay the same predecessor idempotency key after a lost response/restart.
Logout hides account data immediately, journals intent, reconciles any pending rotation, then
revokes the successor. Credentials are cleared before the logout marker, only after confirmed
revocation, session expiry or refresh 401. Network/5xx/storage errors retain recovery state and
show retry, never a false successful logout or a new login over an uncertain saved session.

Native mode does not initiate general Viva delegation/provider jobs, web OAuth recovery, browser Web Push,
payment creation/handoffs or attachment flows. Java permits only current canonical reads and
notification preference/read-cursor commands. New routes require an explicit native review.
Web retains its existing transport; persistent Android mode requires an injected native fetch.

### My Bookings refresh

The owner-approved ADR 0023 exception adds one no-argument native operation. An exact
`GET /bookings/upcoming` with an absent or stale projection may call it; unrelated reads, denial,
query variants and fresh projections do not. Java validates the current authenticated lease,
server routing plan and one 120-second `MY_BOOKINGS` command, then performs the existing fixed
list/details reads on the user's device. Token and raw provider payload stay in invocation RAM;
generic `request` still rejects delegation and read-job POST routes. Only the native runner can
use those internal steps. It validates and relays at most 50 active bookings, completes the
PadlHub job, returns a closed acknowledgement, and the ordinary PadlHub GET supplies the UI data.

Logout and abort immediately cancel the read epoch. Every network boundary and submission checks
principal, session generation, credential journals and monotonic deadlines. A provider 401 permits
one delegation refresh and one replay of that GET. Other provider failures have no retry or server
fallback; result/complete lost responses may replay only the same payload and idempotency key.
Partial failure never completes a projection or returns an invented empty result.

Version 1.10/code11 corrects a 1.9 contract mismatch: delegated Viva access tokens are opaque,
not necessarily JWTs with a `tenant_key` claim. Native code accepts only bounded Bearer-safe token
bytes from the authenticated endpoint and keeps the fixed plan tenant/host and current user lease.
Rejected responses expose only one reviewed stage code, never raw payload or credential details.

Version 1.11/code12 corrects the job expiry check: a valid server-issued 120-second job must not
be rejected merely because the phone clock differs. Plan, job and delegation use the `Date` from
their own authenticated HTTPS response, deduct its one-second precision and the complete monotonic
request/processing interval, and retain the original lifetime caps. Malformed/duplicate dates fail
closed; absent dates retain the strict wall-clock path. Check skew in both directions, expired and
excessive lifetimes, response binding and cancellation after a device clock change.

Version 1.12/code13 is a diagnostic build for the unresolved physical-device job rejection.
It splits that job-stage rejection into ten closed reasons: transport framing/bounds, media type,
JSON, screen/concurrency contract, command, identifiers, expiry format, Date, expired lifetime and
excessive lifetime. The accepted response set and all read/expiry/session checks remain unchanged.
No raw response, field name/value, header, URL, provider ID or token becomes a diagnostic. The UI
correlation is the original `/bookings/upcoming` request; internal native job requests have their
own correlation IDs. This build is not evidence that the phone issue is fixed.

Version 1.13/code14 corrects another native/API mismatch: `/auth/viva/access` publishes the
provider credential expiry without a one-hour maximum. Android now accepts a valid longer expiry,
but limits token use to the current validated plan/job deadline (at most 120 seconds); provider 401
reissue cannot extend that deadline. Own-response Date, conservative transit/precision deduction,
strict missing-Date wall fallback, expiry rejection and token grammar/size checks remain in force.
Nine additional closed delegation diagnostics distinguish transport, media, JSON, root contract,
token grammar/size, expiry format, Date, expired credential and invalid timing arithmetic. No
credential, response value, timestamp or parser exception is exposed. This fixes a reproducible
contract defect; the phone's actual token TTL and acceptance remain unconfirmed.

Version 1.13/code14 preserves `ru.padlhub.app`, existing Firebase registration, media, push and
debug-signing identity. Verify the fixed provider host and tenant, protocol/body bounds, 401 versus
403 handling, exact replay, logout/account changes and token/payload absence in bridge/errors/store
with native instrumentation. Physical-device acceptance must separately open My Records and
Profile, then reopen the app; source/CI/build do not prove the installed API gates or native Viva
transport work.
Internal links use same-document history; Android Back uses WebView history then backgrounds
the task at its root.

Version 1.2 adds an encrypted, identity-bound local read cache for HomeBase and the location
directory. See [storage and retention rules](android-local-storage.md) for TTLs, byte limits,
logout erasure, stale-data indicators and the explicit offline-login/command limits.

## Yandex login (1.4/code 5)

The connected native app opens **Войти с Яндекс ID** as its primary login screen.
**Войти по СМС** opens the existing phone/code flow as an explicit alternative; its secondary
**← Войти с Яндекс ID** action returns to the primary screen. Both methods require the same two
legal acceptances. Opening the screen or switching methods does not initiate OAuth or send a code.
Phone-only builds and synthetic/real-account phone previews retain their existing entry.
`AndroidLoginGate` prevents account restoration or parallel phone login while a native attempt
needs resolution. The system browser performs the existing server-owned Viva/Yandex flow.
No client secret, Viva token, browser refresh cookie, WebView OAuth page or new dependency is used.

1. Native code generates a 256-bit client state and S256 verifier, then atomically encrypts its
   attempt before POST `/auth/viva/android/start`. Only the challenge and consent go to this endpoint.
   A five-minute, one-use launch ticket is stable for the same idempotency key/body.
2. Native opens the exact configured HTTPS origin and returned fixed `/auth/viva/android/launch`
   path. The browser consumes the ticket, receives the existing state-scoped HttpOnly nonce cookie,
   and follows server-generated provider OAuth. Provider state/verifier are independent of native PKCE.
3. The existing provider callback validates its browser nonce, resolves identity and legal consent,
   saves encrypted delegation and creates an audited PadlHub session. Android flows create a
   metadata-only, 120-second handoff; they never create a Viva access handoff or browser refresh cookie.
4. The callback redirects to the verified App Link
   `https://lk2.padlhub.su/android/oauth/yandex#code=…&state=…`. The fragment does not reach HTTP logs.
   If Android does not claim the link, the static page explains the device state and offers a
   user-initiated return described in [browser fallback return](#browser-fallback-return). It never
   completes login itself and removes the fragment from the address bar and history.
5. Native validates the exact URI/attempt and persists the callback before exchange. POST
   `/auth/viva/android/exchange` proves PKCE and binds the first exchange key atomically. The same
   key recovers a lost response only while the exact session is active, unrotated and unrevoked.
   Native verifies the server-echoed attempt and existing session/cookie contract, writes the
   credential plus attempt marker atomically, then removes the journal. JS sees only login status.

Returning from the browser triggers recovery; **Проверить вход** also retries explicitly. Before
callback receipt, **Отменить вход** erases the proof. After an ambiguous exchange, only recovery or
expiry is allowed. Process recreation retains the same verifier, callback and idempotency key;
crash after credential storage uses its matching attempt marker and does not repeat exchange.
Logout durably records intent before clearing OAuth state, then uses existing revocation recovery.
Old, cancelled, foreign, malformed or duplicate callbacks cannot replace an account or pending code.

### Browser fallback return

Android claims the App Link only where Digital Asset Link verification succeeded on that device. A
VPN or proxy during installation, a differently signed APK, disabled supported links, or a browser
without App Link dispatch leaves the one-time fragment on the web page; users then saw a dead end
that only asked them to change Android settings and start again. The page still never completes
login: the S256 verifier exists only inside the encrypted native attempt journal.

The page keeps the fragment out of the address bar, history and any request and places it only in the
app-return link. For an exact `#code=<43>&state=<43>` fragment it shows a user-initiated
**Открыть приложение** action that opens `padlhub://oauth/yandex?code=…&state=…`, one retry of the
App Link itself, a note that the code expires quickly, and instructions for supported links,
VPN/proxy, updating the app and the SMS alternative. Without a code it reports that the login must be
restarted instead of offering a dead action.

The APK registers `padlhub://oauth/yandex` (exact scheme/host/path, `BROWSABLE`, no `autoVerify`) and
accepts only the exact query grammar before rewriting it to the canonical App Link callback URL.
Custody, attempt expiry, state comparison, PKCE exchange and journal semantics are unchanged; an app
that intercepts the code still cannot exchange it without the verifier. Malformed, extended,
reordered, uppercased or non-canonical fallback intents are ignored exactly like foreign App Links.
The fallback is a transport for the same callback, not a new login or credential path.

A release carrying this fallback needs an APK `versionCode` above the currently distributed build;
no version is assigned by this source change. `1.14/code 15` is currently used by the unmerged
read-observation Draft PR #386, so the release owner chooses the next free version when assembling
the APK.

### Deployment and certificate prerequisites

This increment requires the API and Web source together. Preparing an APK or merging source does
not deploy those endpoints. The provider callback configuration is unchanged. Publish only through
the existing approved delivery process; no provider registration, signing key or live setting is
changed by development.

The checked-in `apps/web/public/.well-known/assetlinks.json` delegates the host to `ru.padlhub.app`
with the **existing controlled-test debug certificate** SHA-256
`22:07:BD:6E:B9:0A:EF:E4:4D:BD:04:3A:9C:FA:CD:17:54:13:13:BE:C3:A5:95:8D:05:1B:E8:07:E0:0B:EF:93`.
It contains no signing key. A debug APK signed by another developer/CI key will not verify.
Before store/release distribution, replace this association with the approved release certificate
and remove the debug fingerprint; do not publish a release-signed APK under this test association.

The exact callback path `/android/oauth/yandex` must return the static fallback HTML directly
with HTTPS 200 and no `Location` header. nginx must select its `index.html` explicitly: directory
canonicalization behind the TLS ingress otherwise redirects to its internal HTTP port 8080.
The response is `no-store` and `no-referrer`; a missing fallback file must return 404 rather than
the SPA shell. Also check HEAD, the trailing-slash path and the unchanged association file.
The Docker-enabled CI fixture exercises the shipped nginx configuration; the browser test executes
the fallback's fragment cleanup, fallback action, malformed-input rejection and restart guidance with
synthetic values. Neither proves device App Link dispatch or a browser's custom-scheme launch. On a
controlled device, start an authorized login while the App Link is unverified or unsupported, check
that **Открыть приложение** opens the app and completes the existing exchange, and that a malformed,
extended or replayed fallback intent changes nothing; then restore the association.

After an approved Web/API rollout, require `/.well-known/assetlinks.json` to return HTTPS 200,
JSON and the exact packaged APK certificate without redirects. On a controlled Android device,
reverify App Links and read back `pm get-app-links ru.padlhub.app`; require `lk2.padlhub.su` to be
`verified` before the real provider acceptance test. A shell-forced test association is not live
verification evidence. Check success, browser cancellation, network loss, process recreation,
logout and the existing phone path using an authorized test account. No live login was implied
by synthetic tests or APK assembly.

Rollback the APK to the previous compatible phone-login version; existing phone/session and web
OAuth contracts remain compatible. New Redis records expire in 2/5 minutes; no schema migration
is needed. A callback crash before handoff publication may leave an undisclosed session that
expires normally; handoff write failure attempts exact-session revocation. Do not revoke another
session or the user's shared Viva delegation as compensation. API logs record redacted exchange
success/rejection plus correlation, without code/verifier/token/query values.

## Reproducible local build

Use the committed lockfile and installed toolchain; the Gradle wrapper pins its distribution
checksum. Set `JAVA_HOME` and `ANDROID_HOME` to existing installations, without committing paths.

```sh
npm ci
npm run contracts:generate
npm run typecheck -w @phub/mobile
npm run test -w @phub/mobile
VITE_PHUB_API_BASE_URL=https://lk2.padlhub.su VITE_PHUB_TENANT_KEY=local-padel npm run android:debug -w @phub/mobile
```

`android:debug` bundles local assets, syncs the same public configuration into Android, then
builds `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Version 1.6/code 7 replaces
versions 1.4/code 5 and 1.5/code 6 using the existing local debug signature. No release keys
are created. Always inspect the packaged `capacitor.config.json`, manifest and signature.

Builds have **no implicit API target**. Missing configuration displays a setup message. The native
release allowlist is exactly `https://lk2.padlhub.su`; debug also allows the existing
`https://lk.nano.padlhub.su`. Credentials, paths, query, fragments and noncanonical ports fail
configuration. Origin and tenant are public build inputs, never keys or account credentials.
Native bundle configuration is authoritative over Vite values. No `server.url` is shipped.

## Verification and limitations

Run the full `npm run check` for this auth boundary. Native instrumentation uses synthetic
senders/credentials and the real emulator Keystore; it never sends SMS or touches a live account.
It covers origin/route/cookie rejection, refresh response loss, persisted logout recovery,
credential-write failure followed by process recreation, expiry/revocation, ciphertext scope
and corruption. Run `:app:connectedDebugAndroidTest` with an owned emulator. Keep a read-only AVD
run without snapshot saving when preserving the user's existing emulator state.

Check the packaged app on Android: initial phone form, keyboard, Back/background and relaunch.
An empty native store must open the form without a network request. A real phone/OTP flow and
account reads on the user's device remain a separate acceptance step. Report `LOCAL`, `CI`,
`STAGING` and `PRODUCTION` evidence separately; synthetic lifecycle proof is not live login proof.

A debug APK is for controlled testing, not store or broad distribution. Keystore/bridge controls
do not remove Android's debuggable application flag. Use a test account, then log out. If both
intent and credential storage cannot be written, the app blocks the current session and reports
failure; no successful logout is claimed. Corrupt/unavailable secure storage fails closed.

Session-check failures show a fixed diagnostic code distinguishing native network, TLS, secure
storage/cache, rejected requests/responses and HTTP status. Only allowlisted native constants and
numeric HTTP status reach this screen; raw errors, causes, server codes, correlation values and
credentials are omitted. Retry preserves native credentials and recovery journals. This diagnostic
does not prove that a failure on a user's device has been repaired.

Native session refresh/logout send empty POST/DELETE with explicit `Content-Type: text/plain`. Android's
`HttpsURLConnection` otherwise adds `application/x-www-form-urlencoded`, which the API's Fastify
parser rejects with HTTP 415 before session validation. Empty JSON is also invalid. Keep lifecycle
calls bodyless and leave JSON OTP/OAuth payloads unchanged. `AndroidHttpSenderTest` checks the actual
Android HTTPS wire format against an ephemeral loopback certificate; the API auth-route test
checks refresh rotation and logout with this format. These tests use synthetic credentials only.

Games/tournaments/training, chats/media, payment return navigation, additional App Links and FCM remain
subsequent complete increments using existing APIs. Release signing, store publication, live SMS,
payments, merge and deployment require their applicable authority and delivery gates.

The fixed My Bookings transport also uses session-bound memory-only circuits with monotonic backoff
(1, 2, 4, 8, 16 seconds) for provider failures. It reports only the existing closed routing outcome
fields to PadlHub after projection completion in a bounded background queue; telemetry is best-effort,
has no retries, and cannot change session/projection
state. Active detail IDs follow the browser contract's 128-character bound; cancelled list entries
are never requested as details. No additional provider operation or server permission is added.
