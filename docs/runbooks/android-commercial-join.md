# Android: existing commercial JOIN transport

## Scope

This increment admits only the existing C1 authenticated JOIN/readback path through `AndroidSessionPolicy`. It does not introduce a CREATE/payment/provider contract, authorize a price or discount, enable runtime commerce flags, change signing/configuration, or certify the Android user journey.

Owned files: `AndroidSessionPolicy.java`, the host-JVM `AndroidGameJoinSessionTest.java`, and this note. C2's existing handoff records the increment separately. The shared TypeScript transport, read observations, auth/session engine, SDK and navigation are not changed. In particular, open PR #386 owns overlapping TS read-observation files; those files are left untouched.

## Admitted routes

All remain under the configured `user/api/v1/{tenant}` root with the existing bearer/session/origin/tenant guards:

- `GET /games`: only optional `scope=UPCOMING|HISTORY`, `limit=1..100`, bounded base64url `cursor`, no duplicate or unknown query keys. The current server encodes game cursors as base64url (`game-card-queries.ts`).
- `GET /games/{uuid}`: no query.
- `GET /games/{uuid}/join-conditions`: exactly `expectedRevision` and `subscriptionInstanceId`, either order; bounded canonical nonnegative safe-integer revision and UUID selection. Query text is validated before percent decoding, preventing hidden delimiters or key duplication.
- `POST /games/{uuid}/join`: existing bounded JSON/body/header handling, no query, caller-owned valid `Idempotency-Key`.
- `GET /games/{uuid}/join-operation`: no query; the same explicit caller-owned key header is required. No key is minted by native code.

These are native transport admission bounds, not a promise of server acceptance. Current `game-read-routes.ts` accepts list limits only in `1..50` and cursor lengths `16..512`; `game-join-conditions-routes.ts` requires a positive revision. The broader native bounds do not bypass those server checks. Host-JVM pagination/query tests exercise policy admission, not a server-validated cursor or successful server pagination.

The Java allowlist was the user-API route blocker. `native-api-fetch.ts` already forwards these user-API requests and only has a special automatic refresh flow for the ordinary bookings GET, not for JOIN. Public catalogue transport remains a separate capability and is not opened by this increment.

Other game mutations (CREATE, cancellation, self-leave, waitlists, results), provider handoffs and unrelated/public routes stay denied. No browser/user payload can choose a provider or API host. JSON business semantics, ownership, consent, amount, operation receipt and capacity remain server-owned; native code forwards the original bytes and does not compute a commercial decision.

The existing SDK's `joinPaidGame` and original-key readback disable network/auth-refresh command replay. The native engine still sends an API request once and returns its result/error. Neither an HTTP error nor a transport timeout is proof of rejection; the Web C2 custody ledger remains responsible for UNKNOWN and explicit original-operation recovery.

## LOCAL checks and limits

The first positive host-JVM test failed with `NATIVE_REQUEST_REJECTED` before the allowlist change. It uses the actual Java policy and engine with synthetic credential-store and sender boundaries; this is not an emulator, a physical device, a real authenticated server, or a process-restart durability test.

The tests cover the list/detail/conditions/command/readback path, byte/key preservation, no POST replay or auth refresh on 401/503/network failure, and rejection of cross-tenant/provider/other-mutation routes, missing keys, duplicate/unknown/encoded queries and unsafe revisions. They do not assert PAID from a synthetic transport response.

The positive request fixture uses C1's actual body keys (`expectedRevision`, `subscriptionInstanceId`, `priceConsent`), not the client-ledger-only `intent` field. A valid transport response still does not establish that a real server accepted the command.

Use the repository's existing installed JDK 21 and SDK 36:

```sh
./gradlew :app:testDebugUnitTest --offline --no-daemon
./gradlew :app:compileDebugAndroidTestJavaWithJavac --offline --no-daemon
```

Generated Android files must first be prepared by the existing `npm run android:sync` workflow. In this task it completed with **zero tracked configuration changes**. Initial missing generated Cordova/assets errors were setup failures, not a behavioral RED. The working JDK was already installed; an earlier Adoptium metadata request returned 403 and no downloaded toolchain was installed. No release/debug signing settings or keys were changed, no APK was published or installed, and no emulator was started for these host-JVM checks.

Full monorepo source gates and independent R3 review are recorded against their exact candidate source. Earlier PR #453 CI on `732f1d07` does not cover this later native edit until a new head is committed/pushed and checked.

## Still OPEN

- Device/WebView Web Locks and persisted browser-origin custody, kill/reopen and account-switch behavior.
- Real server/owner/provider admission, payment return/deep-link/cancel behavior and final projections.
- Public game discovery transport; commercial CREATE/full-price/private court.
- iOS's separate read-only cabinet/native policy. This change does not retrofit iOS or start a platform rewrite.

Missing native storage/locks must continue to fail closed; they do not justify an unsafe localStorage lock fallback. Runtime flags remain unchanged. This document is not activation, merge, publication or deploy authority.
