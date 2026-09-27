# PadlHub iOS development

The iOS app reuses the existing React/TypeScript client in `src`, the PadlHub API SDK,
and Capacitor **8.4.1**. Its Xcode project is checked in under `ios/App/App.xcodeproj`.
The bundle identifier is `ru.padlhub.app`; the deployment target is iOS 15.0.

## Build for a simulator

Requirements: the repository's Node/npm versions, full Xcode, and an installed iOS
Simulator runtime. No Apple Developer account or signing material is needed for this build.
From the repository root:

```sh
npm ci
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  npm run ios:build:simulator -w @phub/mobile
```

The command generates types from the existing OpenAPI contracts, builds this worktree's
web client, copies it into the iOS project, resolves the pinned Capacitor Swift package,
and builds an unsigned simulator app. The first build requires network access to fetch
that package. `DEVELOPER_DIR` only affects this command; it does not change the system's
selected developer tools. Adjust it if Xcode is installed elsewhere.

Output: `apps/mobile/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`.

To work in Xcode after syncing the web client:

```sh
npm run ios:prepare -w @phub/mobile
npm run cap:open:ios -w @phub/mobile
```

Select the **App** scheme and an iOS simulator, then Run. Repeat `ios:prepare` after web
source changes so the native app contains the current bundle. Do not run `cap add ios`
again: the native project already exists.

## API and session increment

iOS uses the **same PadlHub User API** as Web and Android, with `X-App-Platform: ios`.
No per-platform Docker service, backend endpoint, CORS relaxation or Timeweb change is needed.
The repository's Timeweb topology separates API, Web, Realtime, Worker and Migrator by function;
see `deploy/timeweb/compose.beta.yaml` and `deploy/timeweb/target.json`. These are source
contracts, not a claim about live server health or deployed native support.

The iOS entry uses the existing SDK through `src/ios/session.ts`. The native plugin in
`ios/App/App/PadlHubSessionPlugin.swift` registers a small first-party transport backed by
the dependency-free `ios/PadlHubSession` Swift package. Only OTP challenge, four-digit OTP
verification, session refresh/revoke and authenticated context are enabled. The screen ends
at an authenticated greeting and a context check; full cabinet screens remain the next slice.

- The access JWT stays in process memory. The `phub_refresh` cookie never crosses the JS
  bridge, enters browser storage, a shared cookie jar, a log or an API response body.
- Native HTTPS requests use an ephemeral URLSession, no shared cookies/credentials/cache,
  finite timeouts and no redirects. The origin comes from the native bundle; JS supplies a
  named operation, never an arbitrary destination. Viva/OAuth/provider operations are denied.
- Refresh credentials use Keychain `WhenUnlockedThisDeviceOnly`, no synchronization, with
  a separate namespace for bundle ID, origin and tenant. A new installation clears the old
  namespace when its app-container marker is absent. Corrupt records fail closed to signed out.
- Rotation persists the predecessor's idempotency key before sending and atomically saves
  the successor before returning access to JS. A lost response can be replayed with the same
  predecessor/key after process restart. A failed Keychain successor write releases no access
  and retains the durable predecessor journal for recovery.
- Native requests are serialized across awaits. Logout records pending revocation before
  sending; a relaunch finishes it before restoring access. A pending ambiguous rotation is
  reconciled before revoking its successor. Network/5xx do not masquerade as a completed logout
  or an absent session. Expired/revoked credentials are cleared; refresh races remain retryable.
- Native social-login buttons are absent until a reviewed system-browser/app-return contract
  exists. Phone consent, normalization, masking and exact four-digit verification are enforced.
  Capacitor's iOS bridge logging is disabled even in Debug to avoid access-token logging.

The default bundle has **no API target**, shows an unavailable message, and sends no startup
requests. Set both public inputs in the shell for the **whole prepare/build command**, so Vite
and Capacitor receive the same build environment. A Vite-only `.env` file does not configure
the native plugin. No credential belongs in either input.

```sh
# Replace the tenant with a confirmed PadlHub tenant key before building for account testing.
# The example is public build configuration, not authority to send real OTPs.
VITE_PHUB_API_BASE_URL=https://lk2.padlhub.su \
VITE_PHUB_TENANT_KEY='<confirmed-padlhub-tenant>' \
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  npm run ios:build:simulator -w @phub/mobile
```

Release accepts only `https://lk2.padlhub.su`; Debug additionally permits the repository's
staging origin `https://lk.nano.padlhub.su`. Credentials, paths, ports, alternate hosts and
tenant keys outside the OpenAPI pattern `[a-z0-9][a-z0-9-]{1,62}` are rejected. Confirm the
actual target tenant from authorized configuration before live account testing. No real OTP,
live authenticated API call or provider operation is part of local synthetic verification.

## Session verification

Run JS adapter, lifecycle and rendered form tests from the repository root:

```sh
npx vitest run apps/mobile/src/ios packages/api-sdk/src/index.test.ts --maxWorkers=2
npx tsc -p tsconfig.mobile.json --noEmit
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  swift test --package-path apps/mobile/ios/PadlHubSession
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  swift test -c release --package-path apps/mobile/ios/PadlHubSession
```

The Swift package tests use synthetic responses, not a live API. Its Keychain integration
test requires the App-hosted test target: unhosted SwiftPM XCTest has no application Keychain
entitlement. Use an owned simulator's UUID from `xcrun simctl list devices available`:

```sh
npm run ios:prepare -w @phub/mobile
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,id=<owned-simulator-uuid>' \
  -derivedDataPath apps/mobile/ios/DerivedData \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

This uses local ad-hoc simulator signing; it does not use distribution certificates or an
Apple Developer account. The synthetic Keychain test creates and removes only a unique test
namespace. Current automatic Linux CI covers JS/source checks; Swift/simulator results are
separate **LOCAL** evidence. The manually triggered iOS workflow is still a signing placeholder.

## Integration order and remaining scope

The parallel branch `codex/lk2-android-existing-blocks-20260927` owns shared cabinet UI and
the Android memory-session SDK/gateway changes. This branch owns `ios/**` and `src/ios/**`;
its only shared entry change selects `IOSAuthApp` when `Capacitor.getPlatform() === 'ios'`.
Integration order: Android shared UI first, then this iOS transport/entry. One integration
owner must resolve `main.tsx` once and keep platform selection explicit. Do not apply the
Android memory-only/no-refresh policy to the iOS Keychain client or duplicate shared SDK edits.

Remaining work: connect the shared cabinet screens to reviewed native read routes; validate
legal-document return, keyboard/safe areas and a physical device; implement system-browser
OAuth, app links, native push and payment return through their existing contracts. Replace
the template icon/splash before distribution. A verify response followed by a failed first
Keychain write releases no access, but can leave an inaccessible server session until its TTL.

Keep LOCAL, CI and real-device/live-API evidence separate. Merge, distribution signing,
TestFlight/App Store publication, deployment, live OTP/provider operations and payments are
separate actions. This increment does not change backend contracts or server infrastructure.

## Source and generated files

Commit Swift, storyboards, asset catalogs, Xcode metadata, and the resolved Swift package
lockfile. Capacitor's generated `public/`, `capacitor.config.json`, `config.xml`, DerivedData,
archives, and user-specific Xcode state are ignored by `ios/.gitignore`.
Never commit tokens, provisioning profiles, certificates, or generated application bundles.
