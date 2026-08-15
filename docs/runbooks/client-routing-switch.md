# Runbook: client routing plan switch

Use this procedure to switch one tenant between `PADLHUB_ONLY` and
`MIXED_END_USER_READS`. This control changes read transport only; it never changes write ownership,
authentication provider binding or PadlHub UUIDs.

## Preconditions for mixed mode

1. Deploy migrations `0011_client_routing_plans.sql` and
   `0012_client_routing_operation_allowlist.sql` with the same proven API/web image digest.
2. Verify OAuth delegation, single-flight refresh and in-memory-only Viva access tokens.
3. Verify Viva CORS for every exact production LK origin and every route included in
   `--operations`. Only `Authorization` may be sent to Viva under the current CORS policy.
4. Prove the normalizer for every operation included in `--operations` emits PadlHub DTOs and
   PadlHub UUIDs. The operator command also requires the operation to be present in
   `DIRECT_VIVA_CONTRACT_READY_OPERATIONS`; currently only `profile.read` is eligible. Do not
   include an operation while a Viva identifier can reach the browser.
   `FOR_ME` and upcoming `MY_BOOKINGS` use the separate ADR 0020 read-job contract and therefore do
   not add schedule or booking operations to this general allowlist.
5. Confirm `VIVA_DIRECT_READ_ENABLED=true` only in the target staging environment. Keep Home
   backend synchronization and other server Viva reads independently budgeted; mixed mode must not
   create duplicate polling.
6. Record the actor UUID, reason, correlation ID, release digest and rollback owner.

## Dry run

```bash
npm run routing:plan:set -- \
  --tenant local-padel \
  --mode MIXED_END_USER_READS \
  --operations profile.read \
  --actor 00000000-0000-4000-8000-000000000001 \
  --idempotency-key routing-mixed-20260715-0001 \
  --correlation-id routing-mixed-20260715-0001 \
  --reason "staging browser egress soak"
```

Dry run validates input and resolves the active tenant but writes nothing. Repeat with `--apply`
only after review. A repeated apply with the same key and payload returns the recorded revision; a
different payload with that key fails with `IDEMPOTENCY_KEY_CONFLICT`.

For Jetson staging, use the manual `Set staging client routing plan` workflow from `main`. Supply the
reviewed tenant key and operator UUID. An empty confirmation runs only the dry-run. The exact
`APPLY_ROUTING_PLAN` confirmation first repeats that dry-run and then applies the same fixed
`MIXED_END_USER_READS` plan with only `profile.read`, a 60-second client-envelope TTL and
run-scoped idempotency/correlation identifiers. The stored plan remains in force until another
audited plan command replaces it; each authenticated `/routing-plan` response receives a new
bounded expiry. The workflow executes the repository operator inside the digest-pinned migrator
image so `DATABASE_URL` is never copied to GitHub Actions or printed.

The deploy performs a fresh audited dry-run and apply after image pull, migration, TLS and local
HomeBase verification. `FULL_LIVE_HOME` then runs `activate-live-home.sh` and requires fresh Viva,
community, promotion and platform projections. `CLIENT_ASSISTED_VIVA` instead runs
`activate-client-assisted-viva.sh`: it preserves the current Home read mode, disables blocked
server-side Viva Home sync and enables only the browser-assisted transport. Both profiles keep the
global direct-read kill switch and the tenant routing plan as independent rollback controls. Do
not lengthen the response envelope to hide refresh failures; the routing operator intentionally
accepts only 30–300 seconds.

## Mixed-mode smoke

1. Restore a real PadlHub user session with an active Viva delegation.
2. Request `/routing-plan` with `X-App-Platform: web`; verify the expected new revision, a maximum
   300-second expiry and only the explicitly requested `DIRECT_VIVA` operations.
3. Verify the direct request uses the user device network, `credentials: omit` and only the
   `Authorization` header. Confirm no system key, refresh token or external ID reaches storage,
   analytics, logs or product routes.
4. Force a Viva `401`; verify one broker refresh and one replay. Force `429`, `5xx` and timeout;
   verify the stable unavailable state and zero backend Viva fallback.
5. Execute a booking command and an unknown operation; verify both call PadlHub APIs and preserve
   authorization, `Idempotency-Key` and audit behaviour.
6. Monitor direct read latency/errors, broker refresh failures, API Viva egress and Viva rate-limit
   responses through the agreed soak.

For the Home booking screens, additionally verify:

1. activating `Для меня` creates a `FOR_ME` job and produces only schedule requests;
2. activating `Мои записи` creates one `MY_BOOKINGS` job;
3. the browser reads `/v2/{tenant}/bookings?page=0&size=50`, then requests details only for active
   identifiers returned by that response;
4. each result submission returns `202` (or a harmless replay `200`) and completion returns
   `screen=MY_BOOKINGS`;
   for a schedule payload between 1 MiB and 5 MiB, confirm the relay is accepted rather than
   rejected by the framework default body limit;
5. the public response, logs and Redis result contain no Viva booking/exercise identifier;
6. known exercise mappings route to `/games/{padlhubUuid}`, while unmapped records use opaque
   snapshot UUIDs;

## Client-assisted profile photo rollout

Keep `PROFILE_PHOTO_CLIENT_SYNC_ENABLED=false` and
`COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false` through the migration and mixed-version window.
Keep `COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false` during normal operation; it is a
bounded rollback-only maintenance mode.
`PROFILE_PHOTO_MAINTENANCE_ENABLED` is a separate worker-only lifecycle flag: turn it on before
client writes and keep it on until pending commands and all object-GC rows are both zero. Existing
`HOME_VIVA_SYNC_ENABLED=true` workers also continue maintenance for backward compatibility. The order
is mandatory:

1. integrate the reviewed Communities migration history through `0078`, keep the client-assisted
   media migrations at `0079` through `0081`, and run the migrator only from that final monotonic
   chain;
2. deploy and drain **all** API nodes with `PROFILE_PHOTO_CLIENT_SYNC_ENABLED=false`; this makes the
   stable community-logo and profile-photo media routes available before any worker publishes a
   stable URL;
3. deploy workers that accept nullable profile-photo `source_url`, preserve newer browser mappings,
   continue writing legacy signed community-logo metadata while the stable-delivery flag is false,
   and run bounded object/command cleanup; set `PROFILE_PHOTO_MAINTENANCE_ENABLED=true` on workers;
4. deploy the compatible web version, then verify every old API and worker is drained;
5. set `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=true` on compatible workers only after the API route
   is ready, then set `PROFILE_PHOTO_CLIENT_SYNC_ENABLED=true` on API nodes sequentially;
6. verify one authenticated direct-profile journey returns a stable PadlHub avatar URL, the media
   route serves `image/webp`, and neither logs nor integration rows contain the Viva photo URL.

The generic staging deployment never enables stable community-logo delivery. It starts and verifies
the API before the worker, then runs the rollback guard in `pre-cutover` mode, so normal signed-URL
rotation and server-owned profile-photo GC do not disable automatic rollback. This mode still refuses
nullable client-photo sources, client commands, null community delivery pairs, and any stable-route
payload. The worker durably marks the first stable-logo publication, after which the pre-cutover guard
fails closed even if runtime flags are later disabled. Once stable delivery is active, do not use the
generic automatic old-image rollback; use the feature rollback below instead.

For rollback, first disable `PROFILE_PHOTO_CLIENT_SYNC_ENABLED` on API nodes and set
`COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false` and
`COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=true` on compatible workers, but leave
`PROFILE_PHOTO_MAINTENANCE_ENABLED=true` on compatible workers. Do not roll an old worker back over
rows whose `source_url` is null. Stop client-assisted writes, retain a compatible worker until
`profile_photo_client_commands` and `profile_photo_object_gc` are both empty (including completed
idempotency rows and future `delete_after` rows), and only then disable
maintenance or roll back API/web. Existing normalized objects and stable
delivery mappings remain readable.

Community-logo stable delivery is also an expand/migrate cutover. The all-new-API drain in step 2 is
required before workers persist it. Before a full rollback to an API without that route, disable the
stable-delivery flag and run the compatible dual-mode worker until it has repopulated legacy signed
delivery metadata and Home snapshots. Verify there are no active
`(delivery_url, delivery_expires_at)` null pairs or stable-route Home payloads, then disable the
compatibility-backfill flag before restoring an older API or worker.
Restart the compatible API/worker after changing the flags so their actual container environments
match the files. The rollback guard checks both, waits for source/components/snapshots and the Home
projector queue to drain twice, then stops the compatible worker before an old image can start.
Invoke this strict gate as
`PHUB_MEDIA_ROLLBACK_MODE=feature sh /opt/phub/verify-media-rollback-safe.sh`; unlike the generic
`pre-cutover` gate, it also requires zero profile-photo GC rows and fresh, fully converged signed
community URLs. `feature` is the guard default. Only after both strict checks, queue drain, and worker
stop does it clear the durable cutover marker and make future pre-cutover-compatible rollbacks eligible.

Client-assisted mappings intentionally have `source_url=null`; maintenance does not and must not
invent a provider source URL. If any such mapping exists, a full rollback to a pre-client-assisted
worker is unsupported and the strict guard will refuse it. Preserve the last compatible immutable
API and worker digests as the release rollback floor. The application snapshot records the versioned
capability of both images. If a failed deploy replaced or broke the worker, restore the attested saved worker
with `PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases sh /opt/phub/prepare-compatible-worker-rollback.sh <saved-release-directory> PREPARE_COMPATIBLE_WORKER_ROLLBACK`.
Then invoke the saved-release rollback with
`PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases sh /opt/phub/rollback-application.sh <saved-release-directory> --confirm=ROLLBACK_STAGING_RELEASE`.
This release rollback does not change feature flags or backfill data: the attested saved API still
serves stable media routes and the attested worker still understands nullable mappings. The rollback
script restores the snapshot's known-good immutable API/worker digests and proves the attested worker
container remains running. Before changing release files it revalidates that exact container's
versioned `phub.client-media-rollback.v1` capability, closing the gap between snapshot and rollback.

This is distinct from a feature rollback to images without that capability. For such a rollback,
disable writes and stable delivery, run compatibility backfill, and require
`PHUB_MEDIA_ROLLBACK_MODE=compatible-worker` to drain client commands, community signed delivery, and
the Home queue while the compatible worker remains running. Do not rewrite `source_url` or delete a
user's avatar merely to make an old worker start; if nullable mappings remain, restoring a
pre-client-assisted worker is unsupported and requires a separately approved user-data repair.

API/worker logs must show zero server-side schedule or booking egress during the browser journey.

Do not add `bookings.read` or `bookings.details.read` to
`DIRECT_VIVA_CONTRACT_READY_OPERATIONS`; the fixed read-job chain is the only approved browser
transport for those provider routes.

## Switch to PadlHub-only / rollback

Run the same command with a new idempotency key, `--mode PADLHUB_ONLY` and no `--operations`. In an incident, also set
the global `VIVA_DIRECT_READ_ENABLED=false` and roll API nodes sequentially. New plans and delegated
access-token issuance become PadlHub-only immediately; existing short-lived plans/tokens expire
naturally.

After the maximum TTL, verify:

- `/routing-plan` has the new revision and no `directViva` block;
- every read calls PadlHub APIs;
- no browser calls Viva and backend egress stays within its approved budget;
- commands and existing PadlHub sessions remain unaffected;
- the audit row contains only mode/revision/TTL metadata and no token or user payload.

Do not down-migrate the table during rollback. Preserve command and audit history.
