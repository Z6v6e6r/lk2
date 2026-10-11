# Android chats and FCM

The Android application uses `ru.padlhub.app` and the existing authenticated PadlHub chat APIs.
History recovery uses HTTP; live messages use the existing short-lived messaging WebSocket ticket.
The bundled native allowlist pins the API origin and tenant. It does not expose a provider transport.

## Attachments

Android upload intents return a relative PadlHub relay descriptor. They never issue an S3 grant.
`PUT /user/api/v1/{tenantKey}/conversations/{conversationId}/media/{mediaId}/bytes` accepts raw
`application/octet-stream` up to 15 MiB, with a dedicated required command idempotency key; the UI
creates a fresh key for each transfer.
The API checks the current writer, uploader, intent state/expiry, byte count and SHA-256; an ambiguous
immutable storage write is reconciled against its exact checksum and object version before finalization.
Finalization rechecks membership in its mutation transaction. Android content reads return bounded bytes;
browser clients keep signed redirects.
The Capacitor bridge uses internal base64 only; the HTTPS request contains raw bytes.
Relay authentication and its four-per-minute principal limit run before parsing the body. Android
content reads share a 60-per-minute principal limit and buffer budget of four reads per principal,
eight per API process; budget slots remain held until the response finishes or closes. Rotating an
access token does not reset these limits. Matched relay uploads append a source-upload audit with a
digest of the command key, excluding the raw key and internal object path.

## Configuration and activation

Source implementation and a debug APK do not establish provider or device delivery.
The supplied Firebase project is `padlhub` (project number `743700931941`), whose supplied link selects
`com.cabinet.app`. That client's configuration must not be used for `ru.padlhub.app`.

Before an explicitly approved provider activation:

1. Register or select the Android client **ru.padlhub.app** in the intended Firebase project and place
   its public client configuration at `apps/mobile/android/app/google-services.json` (Git ignored).
   Keep API restrictions appropriate to that client. A missing file leaves FCM unavailable in the APK.
2. Prepare a server service-account file through the existing secret-management process; never put
   private keys in Git, client assets, reports or chat. The worker accepts an absolute non-symlink
   regular file owned by its UID with mode 0600, matching project and the fixed Google OAuth URL.
3. Configure `FCM_PROJECT_ID`, `FCM_CREDENTIAL_FILE`, `FCM_APP_ID=ru.padlhub.app` and the intended
   `FCM_ENVIRONMENT`. The existing endpoint encryption keyring remains server-owned.
4. Provision/select the existing ANDROID/FCM provider account and enable the tenant's
   `android_push_enabled` only under separate live-target authority. `FCM_ENABLED` defaults to false;
   when disabled the worker reads no FCM credential, projects no Android delivery and runs no FCM cycle.
5. Build and deploy the reviewed source through the existing release process, then test on a real
   Android device: consent, registration/rotation, foreground/background delivery, tapping into the
   correct chat, logout, account switching, permission denial and an offline retry.

The notification owner uses the global and tenant gates for activation/recovery. Review them after
the first accepted device rollout; preserve them as operational transport controls. Disabling the
global gate stops new FCM projection/sends without disabling the in-app inbox. Events acknowledged
while FCM is disabled are not automatically replayed when it is enabled.

## Delivery semantics and recovery

FCM sends data-only opaque identifiers and a canonical local chat route, never message text, sender,
raw user/tenant identifiers or credentials. Native code checks the current account and endpoint before
displaying generic text. Registration/revoke keys persist until acknowledged; logout suspends locally
before network waits. Installation ownership transfer revokes the previous endpoint without
retargeting its pending deliveries. The native token is not stored by PadlHub in its metadata file.
Notification taps require a one-use random native capability bound to the delivered account and
canonical route. Forged activity extras cannot select a route. On refresh, denied OS permission
suspends the active endpoint locally and revokes it through the authenticated API.

One delivery is claimed per 60-second lease. Token acquisition, HTTP and response parsing share a
bounded operation deadline. Retry-After is capped at one hour; circuit-open deferral does not consume
an attempt. FCM TTL is 24 hours, and the native delivery-id journal retains 48 hours, failing closed
at its bounded capacity. Duplicate messages after an ambiguous provider acceptance are suppressed.
Only explicit FCM UNREGISTERED invalidates a token. Provider acceptance is not device display/open;
this slice does not produce native display/open receipts.

Worker readiness exposes FCM forward progress; bounded provider outcome and cycle metrics use the
`phub.worker.fcm.*` instruments without token/payload labels. CUP Android campaigns remain outside
this application/event-delivery slice and continue using their existing disabled capability.

## Local verification

Use synthetic injected repositories, OAuth/FCM and S3 transports; these tests never call providers.
Run `npm run check`, the focused Android/media/FCM suites, and a versioned debug APK build following
`android-development.md`. Do not provision a database, change Firebase/server configuration or send a
real test message as part of source verification. Device/provider and live activation evidence are
separate. The Firebase JSON and any signing/private credential files stay excluded from commits.
