# Android LK2: shared-client development

The first Android increment reuses `apps/web/src/App.tsx`, its existing screens, navigation,
assets and CSS in `apps/mobile`. The checked-in Android project is based on the earlier
Capacitor 8.4.1 shell at `9c3b3dd0`; the current product source comes from this task's
`origin/main` base `61a69291`. No separate Kotlin product UI or backend contract is introduced.

## Current increment

Native mode enables the existing Home, profile, profile-level history, bookings/history,
notifications and location screens. Other sections display an explicit unavailable screen.
This is an implementation stage toward the complete LK2 product, not a reduced product scope.

The API SDK's opt-in `sessionMode: 'memory'` keeps the access token in process memory, omits
cookies, disables refresh/retry on 401 and clears the token on local logout. A 401 belonging
to an old token cannot invalidate a newer session. Web retains its existing cookie mode.
Internal links use same-document history so navigation does not discard the process session;
Android Back uses WebView history, then backgrounds the task at its root.

Native mode does not initiate Viva delegation, provider reads/jobs, OAuth/recovery, browser
Web Push, payment creation/handoffs or attachment upload/download flows. Browser-only routes
and native gateway calls are both guarded. A server refresh session created by OTP is not
revoked by local native logout; a reviewed native session lifecycle remains required.

## Reproducible local build

Use the installed Node/npm versions allowed by the root engines, the committed lockfile,
JDK 21 and Android SDK 36. The Gradle 8.14.3 wrapper pins its distribution checksum.

```sh
npm ci
npm run contracts:generate
npm run typecheck -w @phub/mobile
npm run test -w @phub/mobile
npm run android:debug -w @phub/mobile
```

Set `JAVA_HOME` and `ANDROID_HOME` to the developer machine's existing installations. Do not
commit these paths. `android:debug` builds local web assets, runs `cap sync android`, then
`assembleDebug`. Do not run `cap add` for an existing project. Output:
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

The default build has **no API target**. It displays a configuration message and sends no
startup network requests on Android. `VITE_PHUB_API_BASE_URL` and `VITE_PHUB_TENANT_KEY` are
public build inputs, never credentials. The native origin allowlist currently contains only
the repository's existing staging origin `https://lk.nano.padlhub.su`; a new target requires a
reviewed source change. Values with credentials, paths, query, fragments, lookalike hosts or
non-default ports fail startup. Do not embed Basic Auth, API keys or account tokens.

**Device-to-API login is not yet implemented end to end.** Android's local WebView origin is
`https://localhost`, whereas the current staging ingress has a browser-origin contract. Passing
the allowlisted API origin at build time does not establish CORS, cookie or native transport
support. This change does not modify ingress/CORS or claim a live Android login. The default
APK is a source-review shell, not an authenticated user testing or store release build.

## Verification and next boundary

Tests cover origin/tenant rejection, cookie omission, no provider/OAuth/payment/media calls,
process-session expiry/logout, stale-401 isolation, same-document navigation and phone-only
native rendering. Browser UI checks use intercepted synthetic responses and a simulated native
platform; they are distinct from an emulator/device run. Keep APK build, browser rendering,
CI and live-backend evidence separate.

Before enabling account testing on a device, implement/review the exact native first-party
transport and refresh/revoke contract, then its Android Keystore storage and lifecycle tests.
After that, integrate games/tournaments/training, chats/media, payment return navigation,
App Links and FCM as separate complete increments using existing product/API blocks.
Run owned device/emulator checks for Back, rotation, process restart, keyboard, system insets,
expiry, logout and reconnect. The inherited icon/splash assets remain Capacitor placeholders.
Release signing, store publication, live SMS, payments, merge and deployment are separate actions.
