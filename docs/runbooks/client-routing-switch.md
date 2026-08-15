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

1. integrate the reviewed migration history through `0078`, then apply
   `0079_profile_photo_client_assisted_source.sql`,
   `0080_community_logo_stable_delivery.sql` and
   `0081_community_logo_stable_delivery_validate.sql` in that monotonic order;
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
fails closed even if runtime flags are later disabled. Once stable delivery is active, never restore a
pre-feature image that lacks the stable route. Automatic repeat-deploy rollback is allowed only through
the stable-to-stable compatible-worker flow below. Use the feature rollback only when deliberately
returning community logos to signed URLs.

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
capabilities of both images separately. The automatic workflow classifies this client-only state as
exit `42` and carries the `client-media` compatibility floor through every rollback command. For a
manual recovery, restore and verify the attested saved worker before changing release files:

```sh
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media \
  PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/prepare-compatible-worker-rollback.sh \
  <saved-release-directory> PREPARE_COMPATIBLE_WORKER_ROLLBACK
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media \
  PHUB_MEDIA_ROLLBACK_MODE=compatible-client \
  sh /opt/phub/verify-media-rollback-safe.sh
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media \
  PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true \
  PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/rollback-application.sh \
  <saved-release-directory> --confirm=ROLLBACK_STAGING_RELEASE
```

This release rollback does not change feature flags or backfill data: the attested saved API serves
client media and the attested worker understands nullable mappings. The scripts restore the
snapshot's known-good immutable API/worker digests, require both community-logo flags to remain
`false`, and revalidate `phub.client-media-rollback.v1` on the exact worker container. The
community-logo capability is not required for this floor, so the first deployment after the
client-media release can still recover to its saved image.

This is distinct from a feature rollback to images without that capability. For such a rollback,
disable writes and stable delivery, run compatibility backfill, and require
`PHUB_MEDIA_ROLLBACK_MODE=feature` to drain client commands, community signed delivery, and
the Home queue while the compatible worker remains running. Do not rewrite `source_url` or delete a
user's avatar merely to make an old worker start; if nullable mappings remain, restoring a
pre-client-assisted worker is unsupported and requires a separately approved user-data repair.

API/worker logs must show zero server-side schedule or booking egress during the browser journey.

## Stable community-logo delivery rollout

This subsection governs only community logos shown in Home and community responses. The
browser-assisted profile-photo path already present in the release remains governed by the previous
section; this logo cutover does not change booking relay limits.

Keep `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false` and
`COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false` explicitly in staging through migration and
the mixed-version window. The second flag is rollback-only. The current migration chain ends at
`0081_community_logo_stable_delivery_validate.sql`; its media prerequisites are
`0079_profile_photo_client_assisted_source.sql`, the logo expand migration
`0080_community_logo_stable_delivery.sql`, and the separate logo validation migration
`0081_community_logo_stable_delivery_validate.sql`.

The `MEDIA_BINARY_ONLY` role check extends the core split-role boundary with an explicit `media`
scope. Before the release window, the exact bounded migrator role must directly own
`integration.user_profile_photo_sync` and `integration.community_logo_sync`; membership in a broad
owner or administrator role is not accepted. The exact runtime role must already hold direct
`SELECT/INSERT/UPDATE/DELETE` (without grant option or other relation privilege) on both mappings,
with no `PUBLIC` or third-party grant; the media precheck validates their owner, ACL and exact tenant
RLS policy before shared DDL. Provision only the schema-local default privileges needed by the new
media tables, while connected as the exact migrator role and after substituting identifiers from the
approved role inventory:

```sql
revoke all on table
  integration.user_profile_photo_sync,
  integration.community_logo_sync
  from public;
grant select, insert, update, delete on table
  integration.user_profile_photo_sync,
  integration.community_logo_sync
  to "<runtime-role>";
alter default privileges for role "<migrator-role>" in schema integration
  revoke all on tables from public;
alter default privileges for role "<migrator-role>" in schema integration
  grant select, insert, update, delete on tables to "<runtime-role>";
```

Do not create a global default grant and do not use `GRANT ALL`. The media precheck rejects a
missing owner, missing runtime schema `USAGE`, a grant option, `PUBLIC`, a third grantee, or any
privilege outside the four DML operations. Its postcheck covers both altered mappings, all four new
media relations, their exact RLS policy inventory where tenant-scoped, and the non-tenant cutover
row. The restored-clone runtime probe is bounded to the exact active `local-padel` staging tenant,
performs tenant-local writes inside a rolled-back transaction, and proves a different tenant cannot
read or write the observation row.

Roll out in this order:

1. run the read-only `diagnose_media` baseline with the exact currently serving release. Require
   its migration/storage/capacity artifact before authorizing `MEDIA_BINARY_ONLY`. The ledger must
   already be complete through `0078`; only the monotonic `0079`–`0081` suffix may be pending, and
   an active stable-logo cutover is not eligible for this pre-cutover profile;
2. preserve and validate the digest-pinned application snapshot, including runtime env state and
   the `phub.client-media-rollback.v1` capability required by a client-media floor. The
   community-logo capability becomes mandatory only for the later stable-cutover path;
3. retain ownership and ACL metadata in the backup, then restore it into a new isolated database on
   the same approved PostgreSQL 16 server. Require the clone `media` role precheck, migrate it with
   the exact bounded candidate, require a second no-op migrator run, pass the role postcheck and
   rolled-back runtime DML/RLS probe, verify the full ledger/RLS/constraint manifest, and confirm
   strict clone deletion before the shared migration. The generic portability restore may suppress
   owner/ACL application, but the media rehearsal must not;
4. verify migrations `0079`, `0080` and `0081` are recorded with both feature flags still false;
5. deploy and drain every API node first, then verify both profile-photo and community-logo routes
   through canonical Caddy/Nginx HTTPS while the previous web, worker and realtime binaries remain
   serving;
6. deploy worker and realtime sequentially with stable delivery still false, and verify workers
   continue to publish compatible signed URLs. Recreate candidate Nginx, repeat the old-manifest
   media smoke, then replace web last; after promoting Caddy, repeat the media smoke against the
   candidate manifest;
7. prove all old API and worker processes are gone and run
   `PHUB_MEDIA_ROLLBACK_MODE=pre-cutover sh /opt/phub/verify-media-rollback-safe.sh`;
8. after a separate approval, enable `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=true` on compatible workers sequentially. Keep
   compatibility backfill false. Verify the durable cutover marker, a Home response containing the
   PadlHub route, `image/webp` delivery, and the absence of legacy source URLs in clients or logs;
9. with the same stable flag enabled, drain and restart every compatible API node. Verify directory
   and detail responses now contain the same PadlHub route and perform an exact route read-back.

Normal deploy preflight accepts either the attested pre-cutover state (`false/false`) or the stable
state (`true/false`). It always rejects compatibility backfill. Every non-legacy deployment profile
runs the flag-only postcheck and proves that both API and worker processes received the selected
stable flag, so a later exact-digest deploy does not silently revert directory/detail responses to
signed URLs. The fuller real-data verification remains an additional `FULL_LIVE_HOME` gate.

The worker revalidates unchanged source URLs conditionally, limits one cycle to 20 source URLs with
at most four concurrent operations and two bounded HTTP attempts per URL, and processes only the ten
communities rendered in Home. `Retry-After` is capped at five seconds and the worker-lifetime
host-level circuit uses the existing Communities failure threshold/reset settings. A bounded S3
HEAD repairs a missing immutable object with an unconditional import, and the S3 canary participates
in worker readiness. Provider failures retain the last local object. These limits are part of the
rollout invariant, not operator tuning.

Before the first stable publication, the generic deployment may use the `pre-cutover` guard. Once
`integration.media_cutover_state` records an active cutover, never restore an API without the stable
route directly. A normal repeat-deploy rollback is stable-to-stable: restore the digest- and
capability-attested saved worker with its saved `true/false` flags. The automatic workflow
classifies this state as exit `43` and carries the `community-logo` compatibility floor through the
following equivalent manual sequence:

```sh
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo \
  PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/prepare-compatible-worker-rollback.sh \
  <saved-release-directory> PREPARE_COMPATIBLE_WORKER_ROLLBACK
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo \
  PHUB_MEDIA_ROLLBACK_MODE=compatible-logo \
  sh /opt/phub/verify-media-rollback-safe.sh
PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo \
  PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true \
  PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/rollback-application.sh \
  <saved-release-directory> --confirm=ROLLBACK_STAGING_RELEASE
```

Keep the currently compatible API route serving while the guard runs. The `compatible-logo` guard
requires stable delivery to remain enabled in runtime and every running API/worker, rejects
compatibility backfill, verifies twice that every stable Home reference still has a DB mapping, and
drains `phub.home-projector.v1`. The rollback then preserves the attested saved worker while
replacing the API with the saved stable-route-capable digest. Both client-media and community-logo
capabilities are mandatory for this floor. This automatic application rollback does not perform a
feature rollback or rewrite URLs.

For a feature rollback to images without the stable route:

1. set `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false` and
   `COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=true`, then restart the compatible worker while
   keeping the compatible API route available;
2. wait until every logo mapping and Home source/component/snapshot/outbox payload uses a fresh
   signed URL;
3. disable compatibility backfill, restart the compatible worker, then drain and restart every
   compatible API node with both flags false. Run
   `PHUB_MEDIA_ROLLBACK_MODE=feature sh /opt/phub/verify-media-rollback-safe.sh`;
4. the guard verifies convergence twice, drains `phub.home-projector.v1`, stops the worker, rechecks
   state, and only then clears the durable cutover marker;
5. restore the older API and worker only after the guard succeeds. Do not down-migrate `0079`, `0080` or
   `0081`; preserve the expanded schema for a forward recovery.

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
