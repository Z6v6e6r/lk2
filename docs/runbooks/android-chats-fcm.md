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
`phub.worker.fcm.*` instruments without token/payload labels.

## Server delivery from CUP

The existing CUP Android card is controlled by the PadlHub Admin API capability response. Android
is available only when the global FCM gate, API endpoint cipher, tenant Android gate and an active
`PUSH/ANDROID/FCM` provider account match the server-selected app/environment. Web Push may stay off.
APNs remains unavailable. The active CUP is the external ph-admin panel; `apps/cup-admin` is its
development harness.

Recipient preview uses the same active-user and authoritative UUID/phone resolution as existing
campaigns. It reports Android only for consenting recipients with an active matching endpoint.
A campaign rechecks the gates and preferences in its tenant transaction, writes one intent per
matched user, queues only the selected platform endpoints, and writes audit/outbox records atomically.
The existing actor-bound idempotency journal replays an accepted command without new deliveries even
when FCM is subsequently disabled. A mismatched request hash returns a conflict. If all selected
endpoints disappear before queueing, the intent completes as delivered in-app or suppressed.

FCM still sends only opaque IDs and a safe route. Android displays generic text. Select **Android +
Центр уведомлений** in CUP when the recipient should read the authored title/body inside PadlHub;
the Android-only channel does not create an inbox item. Provider acceptance, device display and
opening the notification remain separate evidence.

### Operator preparation and activation

These are deployment/activation instructions, not actions performed by source tests. Use the
existing release/secret-management process and obtain authority for the exact environment and
tenant before changing credentials, deploying or applying either operator.

1. Prepare the Firebase service-account credential for project `padlhub` privately. Mount it
   read-only to **worker only**, at its absolute `FCM_CREDENTIAL_FILE` path, with worker UID ownership
   and mode 0600. API receives the path reference for configuration validation and does not read the
   credential. Do not mount it in web, CUP, Android, realtime or migrator. No private key enters a report.
2. Set matching `FCM_PROJECT_ID=padlhub`, `FCM_APP_ID=ru.padlhub.app`, `FCM_ENVIRONMENT` and endpoint
   encryption keyring on API/worker. Keep `FCM_ENABLED=false` until the reviewed candidate and file
   permissions are verified. Do not change VAPID/receipt configuration to make Android work.

   The Timeweb contract permits the five FCM identity/gate keys only on API and worker, and requires
   matching project/app/environment/keyring when enabled. Use
   `FCM_CREDENTIAL_FILE=/run/phub/fcm-service-account.json`. The private host file is
   `/etc/phub/timeweb-beta-fcm/fcm-service-account.json`: regular, non-symlink, one link, UID 1001,
   mode 0600, at most 16 KiB. Its separate directory is real, root-owned and 0700; it is outside the
   managed runtime-env set so env rotation never copies or removes the credential. Prepare it only
   through the approved secret process. The canonical
   `render-timeweb-beta-release-env.js --compose-stage` controller derives the worker-only bind
   from its validated runtime env files and checks credential metadata before Compose. The bind
   is read-only and never creates a missing host path. An ambient
   `TIMEWEB_FCM_CREDENTIAL_SOURCE` override is rejected. With FCM absent/disabled it binds only
   `/dev/null`; no credential file is required or inspected. Existing API/Web component upgrades
   preserve the running worker and do not activate FCM.

3. Preview the provider account using an existing active tenant operator with
   `admin`/`notifications.manage`; the command reads no Firebase credential and sends no push:

   ```sh
   npm run notifications:android-push:provider:set -- \
     --tenant-key=local-padel --actor-id=<approved-operator-uuid> \
     --app-id=ru.padlhub.app --environment=SANDBOX --state=on
   ```

   Apply the reviewed selector with `--confirm=APPLY_ANDROID_PUSH_PROVIDER` only under live authority.
   Use the chosen environment consistently; it selects provider records and does not create a
   separate Firebase sandbox project. The operator rechecks permission and state under a lock and
   audits the provider status without credential content.

4. Preview the tenant gate with `notifications:runtime:set -- --tenant-key=local-padel
--actor-id=<approved-operator-uuid> --android-push=on`. Apply only under live authority using
   `--confirm=APPLY_NOTIFICATION_RUNTIME`. Other channel and booking settings default to `keep`.
   Existing booking-reminder activation prerequisites remain unchanged.
5. Deploy the same reviewed API/worker immutable artifacts through the existing release runbook,
   enable matching `FCM_ENABLED=true`, and verify readiness plus the authenticated Android
   configuration/capability. An HTTP timeout does not establish runtime state.
6. On installed APK 1.8 or newer, enter **Уведомления** after login and enable notifications if not
   registered. Resolve only the approved test user's PadlHub UUID in CUP. Check the exact recipient
   preview and select only **Android + Центр уведомлений**. Send one generic test with its existing
   command key, then read back the campaign/queue/provider outcome before any retry. Reopening or
   clicking Send again can create a new campaign; an ambiguous response is not permission to do so.
7. Verify foreground/background delivery, tap into the notification centre, logout/account switch,
   denied permission and rotation/offline recovery on the real phone. No USB is required.

Rollback containment is `FCM_ENABLED=false` on API/worker and `--android-push=off` through the same
audited tenant operator. Provider disabling uses `--state=off` on the exact selector. Keep encrypted
endpoints, campaigns and delivery evidence for reconciliation; do not delete or retarget pending
deliveries. Re-enable only after readback: queued work may resume, while events acknowledged during
global disablement are not automatically replayed.
For an image/source rollback to the predecessor without FCM support, restore its receipt-bound
runtime env set through the existing recovery procedure; that predecessor rejects the new FCM
keys. Preserve the separate credential file privately and keep the notification keyring unchanged.

## Local verification

Use synthetic injected repositories, OAuth/FCM and S3 transports; these tests never call providers.
Run `npm run check`, the focused Android/media/FCM suites, and a versioned debug APK build following
`android-development.md`. Do not provision a database, change Firebase/server configuration or send a
real test message as part of source verification. Device/provider and live activation evidence are
separate. The Firebase JSON and any signing/private credential files stay excluded from commits.
