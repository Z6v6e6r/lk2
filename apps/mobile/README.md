# PadlHub iOS development

The iOS app reuses the existing React/TypeScript client in `src`, the PadlHub API SDK,
and Capacitor **8.4.1**. Its Xcode project is checked in under `ios/App/App.xcodeproj`.
The bundle identifier is `ru.padlhub.app`; the deployment target is iOS 15.0.

## System bars and display cutouts

Both native shells contain the WebView inside the system safe area by default. On Home,
the presentation-only `PadlHubViewport` Capacitor plugin extends its top to the window edge,
and paints an opaque violet status strip (`#9474ff`), matching the sticky Home tabs.
The strip stays the same color while scrolling; cards and photos cannot show through it.
Home controls and sticky tabs use the reported CSS-pixel top inset. Status icons stay light
throughout Home scrolling.
Dialogs and other routes restore native containment and dark icons. Heights come from the
operating system, never from a device-model table or a fixed CSS-pixel value.

Android `MainActivity` applies system-bar/display-cutout insets to the WebView container,
uses the larger of keyboard and navigation insets at the bottom, and passes zero handled
insets to Chromium. Capacitor `SystemBars.insetsHandling` is disabled because native layout
already owns the viewport. iOS `PadlHubBridgeViewController` constrains WKWebView to
`safeAreaLayoutGuide`; `ios.contentInset=never` prevents a second scroll inset. Existing
shared CSS safe-area rules therefore receive zero within the contained native viewport.
Only the Home underlap uses `--phub-status-bar-top`; keyboard, bottom and landscape side
safe areas remain natively contained. The scrim follows the painted viewport width and does
not extend into the excluded side cutouts. It cannot receive input or accessibility focus.
Browser Web layout is unaffected; older native shells without the plugin retain containment.

Regression checks: `AndroidWindowInsetsTest` covers repeated delivery, portrait cutout,
landscape side cutouts, keyboard, underlap switching and restored zero insets;
`PadlHubBridgeTests` covers portrait/landscape containment, the non-interactive scrim and
absence of duplicate WKWebView scroll insets. Native checks assert the strip's opaque violet
color. JS tests cover stable light icons during scrolling, rotation updates, dialog/route
switching and pending native updates. On-device
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
namespace. Automatic Linux CI covers JS/source checks. The path-filtered iOS workflow also runs
synthetic Swift package tests and an unsigned iOS Simulator build on macOS for relevant PRs.
Its build has no API target, runtime push disabled and `CODE_SIGNING_ALLOWED=NO`. It does not
boot a simulator or execute App-hosted Keychain tests. These remain separate device/simulator
acceptance. The workflow refuses tag or manually requested signed releases with
`IOS_SIGNED_RELEASE_NOT_IMPLEMENTED`; an unsigned build is not a signing or TestFlight result.

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
available for viewing. Settings are disabled without save callbacks; game/payment commands and
friends are not connected yet. Unsupported links show an explicit unavailable
screen with navigation back. This is an implementation stage toward the full cabinet, not a
permanent reduction of the mobile product.

The existing DIRECT/GAME text-chat consumer adds `/chats` and `/chats/{conversationUuid}`.
It reuses the Web list/thread/composer and the same native session. Native GETs allow only
`conversations` (`limit <= 100`) and `{uuid}/messages` (`afterSequence`, `limit <= 100`).
Named native commands allow text send, read cursor, bounded notification policy, and an empty-body
realtime ticket. Swift reconstructs each URL/method, validates bodies/headers and rejects all other
chat/media/provider operations. The read-only navigation can show Chats without enabling CREATE.
GAME-only users do not need the direct-create permission to load their authorized conversations.

An unconfirmed message retains its `clientMessageId`/idempotency key in the current mounted thread.
HTTP reconciliation checks for that ID before enabling/repeating the same command. There is no
background/offline send queue and no automatic resend after reconnect or a new login. Realtime
starts only after initial history; tickets go in the first frame, fresh tickets are obtained on
reconnect, and HTTP sequence recovery/polling remains active. Logout/account changes discard late
results, stop sockets/polling and clear the shared unread badge. Read cursors advance only for a
visible thread after history loads. Unread totals cover the existing bounded conversation list.

Personal chat creation starts from an existing game participant's `/profile/{publicUuid}` link.
The existing authenticated `/profiles/{uuid}` projection must match that exact player, have
`OTHER` audience and contain no private account section. The native allowlist permits only this
GET without query parameters. Shared profile UI preserves server chat privacy/capabilities;
friend/contact writes and player search are not added. Other-player avatars use the initials
placeholder, without fetching protected media.

The server-projected `/chats/new?recipientUserId={uuid}&open=1` action rechecks the profile,
current `profile.read`/`chat.direct.create` grants and exact target before the named native
`createDirect` command: POST `/conversations/direct`, only `{otherUserId}`, current JWT and a
stable idempotency key. Swift independently constructs/validates the route, method and body.
One command is active at a time. After an ambiguous response, a user retry checks HTTP conversation
history before retrying the same key; a bounded list miss is not proof of absence. The backend
canonical pair and command ledger prevent duplicate threads. There is no automatic network retry
or offline queue. Route exit clears presentation, and logout/account changes discard commands
and late responses. Successful creation opens the existing text thread; server privacy, blocks,
reachability and stored grants remain authoritative on every command/replay.

This increment does not create game conversations, change membership, send or fetch
attachments, or enable community/tournament writes. Existing media is explicitly unavailable on
iOS; it never falls back to a protected browser fetch. Server messaging gates remain authoritative.
Signing, provider/device acceptance and full B07 closure remain separate requirements.

Private reads require an active native credential. Session generations discard obsolete UI
responses; logout and the next authentication wait for pending SDK reads/refreshes. Final 401s
use durable logout before offering a new login. Private DTOs remain in process memory, and
profile/home IDs must match the current viewer. Relative media fields resolve against the API
origin; navigation stays in the application, while profile sharing uses canonical HTTPS.
A native opaque shield covers windows before iOS captures an inactive/background snapshot.

`src/ios/testing/cabinet-preview.tsx` is a synthetic Playwright interception entry, never imported
by the production entry or used as an API fallback. Block non-loopback network in that preview.
Its browser evidence proves rendering/navigation, not live API/Keychain end-to-end behavior.

The separate native `AppTests/PadlHubDirectIntegrationTests.swift` acceptance suite runs only
when a Debug simulator test host is compiled with `PADLHUB_B07_TEST_HOST`. The flag is never
enabled in project build settings, normal Debug, or Release. Its internal Swift installation
hook is absent from Release and the JavaScript plugin method table. This host cannot initialize
the production URLSession/Keychain session transport: AppTests supplies the existing injected
`SessionTransport` initializer with an in-memory credential store and strict synthetic replies.
The bundled production TypeScript entry, Capacitor command parser and Swift validators remain
in the path. Synthetic OTP verification must create a native credential before protected reads.

Before its first WebView load, this host installs a WebKit HTTP(S) content blocker and an
all-frame document-start WebSocket-constructor denial; failure to install the content blocker
leaves the WebView blank. This is browser-level denial plus an injected native transport, not
an OS network namespace. Unknown fixture calls fail without a network fallback. Push remains
disabled; realtime tickets return the existing disabled response so only HTTP polling is used.

CI owns a fresh disposable simulator and executes this suite without signing. Local execution
requires a separately established task-owned simulator and sufficient disk space; never install
over an existing user/production app. The suite covers participant→OTHER profile→DIRECT, lost
response reconciliation, offline manual same-key retry, capability denial and logout with a
late read. Rendered synthetic profile/error/thread/logout snapshots are retained in `.xcresult`.
Simulator fixtures do not verify real OTP delivery, Keychain persistence, APNs, provider writes,
physical-device behavior or store readiness. No production credential/configuration is required.

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

## iOS APNs signing readiness

The App target uses `App.Debug.entitlements` (`aps-environment=development`) for Debug and
`App.Release.entitlements` (`aps-environment=production`) for Release. AppTests has no application
push entitlement. The capability supports visible alerts; no silent/background execution mode
is added. Native registration remains disabled unless the approved build explicitly sets
`PADLHUB_IOS_PUSH_ENABLED=true` for the whole prepare/build command. Capability source wiring
alone neither enables runtime registration nor configures the backend provider.

Before a separately authorized signed candidate, its owner must supply/confirm the existing Apple
team and App ID `ru.padlhub.app`, APNs capability in that App ID, matching certificate/profile,
release version/build number, public API origin/tenant and backend APNs topic/environment.
Signing material belongs in the approved protected environment, never Git or a build-time web
variable. A development-signed device build uses development APNs; a distribution/TestFlight build
must contain production APNs. Custom export/signing must not silently change this alignment.

After an authorized archive/export, inspect the **final signed app**, not only these source files:
`codesign -d --entitlements :- <App.app>` and `security cms -D -i <App.app>/embedded.mobileprovision`.
Compare the final `aps-environment`, application/team identity and profile capability; record the
source SHA, artifact hash, bundle version/build and signature identity without publishing profile
contents or credentials. A mismatched/missing entitlement is a release stop. Then verify on an
approved physical device: installation/upgrade, token registration/rotation, foreground,
background and cold-start alert receipt, account switch/logout/revocation and opt-out behavior.
Provider acceptance and device receipt are distinct evidence. No unsigned simulator result closes
either. Archive/export, credential installation, provider sends, TestFlight and store publication
require their own exact authority; this source workflow performs none of them.

## Local organizer cancellation

The game detail exposes the existing organizer CANCEL only when the authenticated server's
`allowedActions` includes `CANCEL`. This requires the matching canonical read implementation:
NO_PAYMENT, original organizer, scheduled future game, and matching aggregate/projection revision
in one tenant-scoped SQL statement. A missing/stale projection or unknown payment mode removes
only the action, never the card. Price zero and `NOT_REQUIRED` are not eligibility evidence.
Deploy the compatible API before distributing these clients; older APIs advertised a broader
advisory action. The command writer still rechecks the actual aggregate under its existing lock.

Android allows only the existing POST `/games/:uuid/cancel` with the exact organizer reason,
Bearer and original idempotency key. iOS uses a typed `gameCancel` bridge request; no caller URL
or provider method is accepted. Both retain the SDK's one network retry with the same key.
Logout blocks new sends and late responses synchronously. There is no new command journal.
After an ambiguous acknowledgement, only an authenticated GET displaying `CANCELLED` confirms
the aggregate outcome; unavailable/old reads remain unconfirmed. Manual status refresh never
sends a command. A reload does not claim authorship of the previous cancellation.

Paid/subscription/provider cancellation, refund and entitlement compensation remain unsupported
by this action. Roster/history stays with the existing canonical writer; no forced removal or
station-membership change is introduced. Rollback to an older API may restore its broader advisory action; the unchanged canonical
writer still rejects non-NO_PAYMENT or unauthorized cancellation. Native transport alone never
changes server authorization. No pending training/direct branch is copied.

Verification: focused Vitest including game read/lifecycle fixtures, host JVM policy/engine,
Swift package tests and rendered synthetic UI are separate from Android/iOS app builds and
real-device/backend acceptance. The existing lifecycle PostgreSQL fixture is CI-only; no local
database is provisioned for this packet.

## Official station messages

Android's existing communities thread and iOS's `/chats` community entry now use only
PadlHub history, station-message POST and original-request status GET. The fresh server
`canRequestStationMessage` capability controls the composer; directory verification or a
community name never grants send authority. Other community histories remain read-only.
The initial message packet adds no DIRECT/GAME chat, media or realtime capability.
The separate v3 companion below adds only explicit original read receipts.

Native custody uses localStorage metadata `{requestId, fingerprint}` scoped to the
original tenant/user/community. No message body, token or provider identity is persisted.
Ordinary Web retains sessionStorage. Storage denial, corruption or quota failure blocks
sending. After process restart, reload or an ambiguous response, recovery reads only the
original request UUID; 403/404, timeout and UNKNOWN do not erase custody or generate a new
UUID. While any native request is pending, even an explicit Send with edited text performs
only original status reads; it cannot create or resend a command. Confirmed receipts must match the original request and SHA256 of the normalized
message body before metadata acknowledgement. Logout closes the original epoch before
waiting for revocation; queued hashing/reads and late replies cannot dispatch or acknowledge
under another session. Visible native history is cleared while pending metadata is retained.

The station POST alone permits a 64 KiB serialized UTF-8 envelope and at most 8000 UTF-16
text units. JavaScript, Java and Swift independently reject unknown keys, duplicate JSON
keys, unsupported methods/queries, malformed UUIDs, a mismatched idempotency key and a
caller-selected origin. Other Android command limits remain 16 KiB. The existing SDK
performs no automatic POST or 401 retry for station sends.

Install the matched station owner/message and history API before distributing this client.
An older or disabled server leaves sending unavailable or the original request UNKNOWN;
rollback must retain custody and server receipts. This branch starts from #538 and does not
copy #525 integration or #512/#518 chat work. Integrate overlapping session/policy/cabinet
changes deliberately before combined release and rerun their native regressions.
Host JVM/reference JSON, Swift package and synthetic component rendering are LOCAL source
checks, separate from APK/app compilation, device process-death, live membership and
provider acceptance. No credentials, deployment or store activation are part of this work.

### Station stream v3 adoption

The existing Android community entry and iOS station entry now use fresh authorized v3 summaries
and the shared sequence-aware reader. Only explicit UNADOPTED/NOT_STATION uses old history.
Missing/denied/unproven adopted state remains unavailable, never unread zero. Read marking is
explicit after contiguous displayed coverage; new windows, archives and send acknowledgements
cannot silently mark unseen messages read.

Original read-request metadata persists in native localStorage under tenant/user/community;
exclusive Web Locks serialize two views. No plaintext messages/credentials are stored. Restart,
UNKNOWN or manual pending recovery performs original GET only, and logout/session/epoch changes
drop late results without discarding custody. Missing storage/locks or corruption prevents POST.
Ordinary Web retains sessionStorage. The four exact native routes have independent TS/Java/Swift
validation; stream cursor1024 does not change old history512. Read commands remain16KiB, station
message commands retain their separate64KiB limit. V3 history alone has a3MiB response budget at
the owner API, Android sender+engine+bridge and iOS transport, covering escaped legal text pages.

This source packet starts from #541 and must integrate before tournament native Stage B. It
adds no DIRECT/GAME features from pending branches and changes no signing/workflow/credentials.
LOCAL Java tests use existing JDK21, Android36 compile stubs and reference org.json/JUnit; they
exercise actual policy/engine with synthetic transport, not Android framework/device behavior.
Swift package/app tests are left to automatic iOS CI because of local disk constraints. Android
APK build still needs the separately reviewed Android workflow integration; no dispatch/store
activation is authorized. Preserve original read metadata and server receipts on rollback.
