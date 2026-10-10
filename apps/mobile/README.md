# PadlHub iOS development

The iOS app reuses the existing React/TypeScript client in `src`, the PadlHub API SDK,
and Capacitor **8.4.1**. Its Xcode project is checked in under `ios/App/App.xcodeproj`.
The bundle identifier is `ru.padlhub.app`; the deployment target is iOS 15.0.

## System bars and display cutouts

Both native shells contain the entire WebView inside the system safe area. This keeps
headers, dialogs, fixed navigation and scrolling content below the status bar and outside
camera cutouts, including after rotation. Heights come from the operating system, never
from a fixed number of CSS pixels. The reserved strip uses a light background and dark icons.

Android `MainActivity` applies system-bar/display-cutout insets to the WebView container,
uses the larger of keyboard and navigation insets at the bottom, and passes zero handled
insets to Chromium. Capacitor `SystemBars.insetsHandling` is disabled because native layout
already owns the viewport. iOS `PadlHubBridgeViewController` constrains WKWebView to
`safeAreaLayoutGuide`; `ios.contentInset=never` prevents a second scroll inset. Existing
shared CSS safe-area rules therefore receive zero within the contained native viewport.
Browser Web layout is unaffected.

Regression checks: `AndroidWindowInsetsTest` covers repeated delivery, portrait cutout,
landscape side cutouts, keyboard and restored zero insets; `PadlHubBridgeTests` covers
portrait/landscape containment and absence of duplicate WKWebView scroll insets. On-device
acceptance also checks Home while scrolling, fixed dialogs/navigation, keyboard open/close,
rotation and devices with and without a cutout. Native screenshots and physical-device
acceptance are separate from JS tests and bundle compilation.

Camera decoration is not enabled. Android exposes cutout bounding rectangles, which can
support a decorative ball around a reported circular cutout. They describe an excluded
screen region rather than the precise optical sensor location. UIKit exposes safe areas,
not a portable public camera/Dynamic Island geometry API; do not infer coordinates from
the device model. Keep any future decoration outside interactive content and preserve a
plain status strip when geometry is unavailable.

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
the dependency-free `ios/PadlHubSession` Swift package. OTP challenge, four-digit OTP
verification, session refresh/revoke, context and the reviewed cabinet reads below are enabled.
After sign-in/restoration, `IOSCabinet` reuses the existing Home, Profile, location and game-card
components with the same SDK/session instance. It does not instantiate the browser gateway.

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

## Login roadmap

The connected Android entry uses Yandex ID through VIVA as the primary method and exposes SMS
as an explicit alternative. iOS remains OTP-only until its system OAuth/app-return contract is
implemented. The [local-auth enrollment plan](../../docs/plans/mobile-local-auth-enrollment.md)
prepares verified phone plus verified email/password on one existing PadlHub UUID; it does not
enable LOCAL login or change provider/session contracts.

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

Android shared UI was merged in PR #313 (`7fcdc53d`) and is included in this branch. The
entry selects iOS before loading platform styles/session policy. `shared-app-entry.tsx`
preserves the Android/Web entry; `src/ios/styles.css` preserves the prior iOS login styles.
The iOS SDK explicitly selects cookie mode. Android native sessions were merged in PR #318
(`9af8d13e`). This increment does not modify `App.tsx`, `auth-gateway.ts`, the shared entry,
runtime configuration or Android native transport. Shared leaf-component options preserve
Web defaults.

### Cabinet read increment

The native allowlist constructs GETs under the bundle-selected origin and tenant:

| Scope  | Existing routes                                                                  |
| ------ | -------------------------------------------------------------------------------- |
| User   | `home`, `home/base`, `profile`, `profile/privacy`, `profile/booking-preferences` |
| User   | `bookings/upcoming`, `bookings/history`, `recommendations/bookings`              |
| User   | `locations`, `locations/{uuid}`, `games/{uuid}`, `communities/mine`              |
| Public | `games` (no bearer or cookie)                                                    |

IDs, query keys, enum/range values and request bodies are checked natively. Only bounded
SDK pagination/filter queries are accepted. In particular, the recommendations GET has no
selected-day contract: its calendar is hidden instead of showing unfiltered rows as a date
result. History and public games retain their existing query contracts. There is no provider
read-job POST, arbitrary URL fetch, browser-cookie fallback or new backend endpoint.

Home, upcoming bookings, history, public games, own profile/subscriptions and locations are
available for viewing. Settings are disabled without save callbacks; game/payment/chat commands,
friends and notifications are not connected yet. Unsupported links show an explicit unavailable
screen with navigation back. This is an implementation stage toward the full cabinet, not a
permanent reduction of the mobile product.

Private reads require an active native credential. Session generations discard obsolete UI
responses; logout and the next authentication wait for pending SDK reads/refreshes. Final 401s
use durable logout before offering a new login. Private DTOs remain in process memory, and
profile/home IDs must match the current viewer. Relative media fields resolve against the API
origin; navigation stays in the application, while profile sharing uses canonical HTTPS.
A native opaque shield covers windows before iOS captures an inactive/background snapshot.

`src/ios/testing/cabinet-preview.tsx` is a synthetic Playwright interception entry, never imported
by the production entry or used as an API fallback. Block non-loopback network in that preview.
Its browser evidence proves rendering/navigation, not live API/Keychain end-to-end behavior.

Remaining work: connect booking/payment commands and the remaining cabinet modules through
their reviewed native contracts; validate legal-document return, keyboard/safe areas and a
physical device; implement system-browser
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
