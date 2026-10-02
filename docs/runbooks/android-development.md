# Android LK2: shared client and native session

Android reuses `apps/web/src/App.tsx`, existing product screens, navigation, assets and CSS.
The native shell uses the repository's Capacitor 8.4.1, Java, JDK 21 and Android SDK 36.

## Current increment

The existing Home, profile/level history, bookings/history, notifications and location screens
are enabled. Other sections display an explicit unavailable screen. This is an implementation
stage toward the complete LK2 product, not a reduced product scope. The inherited icon/splash
assets remain Capacitor placeholders.

Phone OTP uses the existing PadlHub challenge, verify, refresh and revoke endpoints. Android
requests go through `PadlHubAndroidSession` and system HTTPS, without browser fetch, shared cookie
jars, CORS changes, provider access or redirects. Native code independently validates the exact
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

Native mode does not initiate Viva delegation/provider jobs, web OAuth recovery, browser Web Push,
payment creation/handoffs or attachment flows. Java permits only current canonical reads and
notification preference/read-cursor commands. New routes require an explicit native review.
Web retains its existing transport; persistent Android mode requires an injected native fetch.
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
   There is no custom-scheme fallback. If Android does not claim the link, the static page removes
   its fragment from history and explains how to enable supported links and restart login.
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
the fallback's fragment cleanup with synthetic values. Neither proves device App Link dispatch.

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
builds `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Version 1.4/code 5 replaces
version 1.3/code 4 using the existing local debug signature. No release keys
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

Games/tournaments/training, chats/media, payment return navigation, additional App Links and FCM remain
subsequent complete increments using existing APIs. Release signing, store publication, live SMS,
payments, merge and deployment require their applicable authority and delivery gates.
