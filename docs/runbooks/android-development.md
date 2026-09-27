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
failed encrypted-record write. Access JWTs remain in JS memory. Refresh journals precede the
network write and replay the same predecessor idempotency key after a lost response/restart.
Logout hides account data immediately, journals intent, reconciles any pending rotation, then
revokes the successor. Credentials are cleared before the logout marker, only after confirmed
revocation, session expiry or refresh 401. Network/5xx/storage errors retain recovery state and
show retry, never a false successful logout or a new login over an uncertain saved session.

Native mode does not initiate Viva delegation/provider jobs, OAuth/recovery, browser Web Push,
payment creation/handoffs or attachment flows. Java permits only current canonical reads and
notification preference/read-cursor commands. New routes require an explicit native review.
Web retains its existing transport; persistent Android mode requires an injected native fetch.
Internal links use same-document history; Android Back uses WebView history then backgrounds
the task at its root.

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
builds `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Version 1.1/code 2 replaces
the earlier offline version 1.0/code 1 using the existing local debug signature. No release keys
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

Games/tournaments/training, chats/media, payment return navigation, App Links and FCM remain
subsequent complete increments using existing APIs. Release signing, store publication, live SMS,
payments, merge and deployment require their applicable authority and delivery gates.
