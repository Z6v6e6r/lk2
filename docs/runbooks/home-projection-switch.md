# Home projection switch

## Purpose

Switch authenticated Home from the local synthetic response to a complete persisted PadlHub
projection without coupling the switch to `VIVA_MODE` or allowing a mock fallback.

## Preconditions

- The snapshot was produced server-side from one committed source revision.
- Every public entity ID is a PadlHub UUID; Viva IDs remain in integration storage.
- The payload validates as `HomeDashboard`, has `snapshot.source=LOCAL_PROJECTION`, identifies the
  authenticated PadlHub user UUID and has a future `staleAt`.
- PostgreSQL backup and rollback image digest are verified before a staging/production rollout.

Do not assemble the import file in a browser from profile, bookings, subscriptions and community
requests. Those responses do not share a version and would recreate the consistency bug this read
model removes.

For the additive HomeBase recovery path, also read
[ADR 0019](../adr/0019-home-base-and-viva-egress-gate.md). `GET /home` remains the complete
compatibility projection; `GET /home/base` exposes local quick actions, community and promotion
envelopes, locations, additional links and capabilities. It excludes the self-profile aggregate,
balance, messaging, counters, upcoming bookings and subscriptions.

## Expand and fill

Apply the expand-only migration while the API still uses its previous mode:

```bash
npm run db:migrate
```

Validate an input without changing PostgreSQL:

```bash
npm run home:projection:import -- \
  --file /secure/path/home-dashboard.json \
  --tenant local-padel \
  --revision 1 \
  --source-event-id 11111111-1111-4111-8111-111111111111 \
  --correlation-id home-import-20260715-0001
```

Review the printed tenant, user, revision, version and freshness values. The command deliberately
does not print the profile or other business payload. Apply the same validated file explicitly:

```bash
npm run home:projection:import -- \
  --file /secure/path/home-dashboard.json \
  --tenant local-padel \
  --revision 1 \
  --source-event-id 11111111-1111-4111-8111-111111111111 \
  --correlation-id home-import-20260715-0001 \
  --apply
```

`applied` means the row changed, `unchanged` is an idempotent retry, `superseded` means a newer row
already exists, and `revision_conflict` means the same revision was reused with another payload.

## Continuous projector

The worker consumes `home.projection.component.changed.v1` events from
`phub.home-projector.v1`. Verify that the queue is durable, quorum-based and has one or more
consumers before enabling projection mode:

```bash
docker compose exec -T rabbitmq \
  rabbitmqctl list_queues name type durable messages consumers
```

For an initial backfill or smoke test, validate a normalized component file without writing:

```bash
npm run home:component:enqueue -- \
  --file /secure/path/home-component.json \
  --tenant local-padel \
  --event-id 22222222-2222-4222-8222-222222222222 \
  --correlation-id home-component-20260715-0001
```

Add `--apply` only after review. This utility writes an audited outbox event and is not a substitute
for the domain owner's transactional event producer. The worker returns `waiting` internally until
all nine component types have arrived; it must not create a partial snapshot.

## Gate 0: trusted Viva egress

Do not assume that successful OAuth or delegated token issuance proves that the worker can read
Viva business data. Before enabling fresh Viva-backed Home sections, run the approved read-only
probe from the exact target worker runtime with the same user-delegation refresh path.

The probe may log only:

- operation name;
- generated correlation ID;
- HTTP status;
- latency;
- strict schema outcome.

Never print or persist an access token, refresh token, provider identifier, response body, phone,
name or another personal field. Use only `GET`; do not use a booking-detail identifier unless it
came from a successful authorized booking-list response in the same probe.

The 2026-07-29 local Gate 0 result was:

| Operation              | Correlation ID                         | Result        | Latency | Schema outcome  |
| ---------------------- | -------------------------------------- | ------------- | ------- | --------------- |
| delegated access-token | `3f9e14b1-30ac-4beb-93a5-c895e27011e1` | `200`         | 610 ms  | valid token DTO |
| profile                | `606f90e2-89fc-405d-ae62-e936f651ce55` | `403`         | 521 ms  | not validated   |
| bookings               | `489852a5-b4d3-4e7d-8527-376aee81a56f` | `403`         | 368 ms  | not validated   |
| booking details        | `6b673038-74c3-4d8d-b5cf-bfb02c602a5c` | not attempted | n/a     | not attempted   |
| subscriptions          | `928ee24e-47bb-4b86-ad06-d558c1341a08` | `403`         | 133 ms  | not validated   |

Authorization-only controls also returned `403` for profile, bookings and subscriptions, so the
correlation header was not the cause. This result is a `NO-GO` for the legacy complete Viva-backed
Home components, for adding Viva-backed sections to HomeBase, or for representing profile
separation as a complete synchronization repair.

The gate becomes `GO` only when bookings, booking details and subscriptions all:

1. return `2xx` from the exact target worker egress;
2. pass the strict `@phub/viva-adapter` schemas;
3. map every provider ID to a PadlHub UUID before projection publication;
4. share the intended coherent source timestamp;
5. leave no token, provider payload or provider identifier in public data or logs.

If the gate remains red, request a trusted user-delegated server/worker egress path from Viva. Do
not enable direct booking/subscription operations, do not post browser-fetched provider payloads
back into the API, and do not refresh the old complete snapshot with an older profile component.

## HomeBase additive recovery

HomeBase can be expanded and verified without changing or deleting the complete HomeDashboard
contract. Verify that the response contains `snapshot`, PadlHub `viewerUserId`, `quickActions`,
`communities`, `promotions`, `locations`, `additionalLinks` and `capabilities`, and omits profile,
balance, messaging, counters, upcoming bookings and subscriptions. Its top-level snapshot contains
`version`, `generatedAt`, `source` and `completeness`, but no `staleAt`; required local fields do not
expire the whole response into a global `503`. For each community and promotion envelope, verify:

- `READY` carries one contract-valid local value plus required `revision`, `observedAt` and future
  `staleAt`;
- `STALE` carries the last contract-valid value, preserves its original `revision`, `observedAt` and
  `staleAt`, and is inside the approved maximum stale window;
- `UNAVAILABLE` carries no fabricated value;
- the self profile is absent and is loaded through its separate routed aggregate;
- a profile `403` does not change independent PadlHub-owned section states.

Keep old clients on `GET /home` during migration. Switch a new client to `GET /home/base` only after
the OpenAPI contract, API/SDK implementation, database RLS, section-state UI and browser failure
isolation pass together. Roll back the client/API image digest without down-migrating or deleting
HomeBase rows.

## Enable Viva source producers

Profile, upcoming Viva bookings and subscriptions can be filled continuously before changing the
API read mode:

```dotenv
VIVA_MODE=sandbox
VIVA_OAUTH_ENABLED=true
HOME_VIVA_SYNC_ENABLED=true
HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED=false
HOME_VIVA_SYNC_INTERVAL_MS=120000
HOME_VIVA_SYNC_BATCH_SIZE=20
HOME_VIVA_SYNC_FAILURE_BACKOFF_MS=300000
VIVA_END_USER_API_URL=https://api.vivacrm.ru/end-user/api
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://media-staging.padlhub.example
S3_REGION=us-east-1
S3_BUCKET=phub-media
S3_ACCESS_KEY=<secret runtime value>
S3_SECRET_KEY=<secret runtime value>
S3_FORCE_PATH_STYLE=true
S3_AUTO_CREATE_BUCKET=false
PROFILE_PHOTO_ALLOWED_HOSTS=.selcdn.ru,.selstorage.ru
PROFILE_PHOTO_MAX_BYTES=8388608
PROFILE_PHOTO_MAX_DIMENSION=1024
PROFILE_PHOTO_WEBP_QUALITY=82
PROFILE_PHOTO_URL_TTL_SECONDS=3600
```

Set `HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED=true` only in local/staging when the separately documented
targeted bridge is required. It may remain enabled while
`LEGACY_GAMES_ROSTER_SYNC_ENABLED=false`: the bridge evaluates only Viva-proven upcoming exercise
IDs and uses shared cache/single-flight/circuit protection. Follow
`docs/runbooks/games-legacy-server-migration.md` for the complete gates and postchecks.

Keep the delegation encryption key only in the secret runtime environment. Recreate the worker so
Docker applies changed environment values. `S3_PUBLIC_ENDPOINT` must be reachable by the client;
it is used only to sign GET URLs, while `S3_ENDPOINT` remains the private worker-to-storage address.
Production bucket provisioning is an infrastructure step and keeps `S3_AUTO_CREATE_BUCKET=false`:

```bash
docker compose up -d --force-recreate worker
docker compose exec -T worker node -e \
  "fetch('http://127.0.0.1:3002/health/ready').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

Enable the existing CUP Home advertising placement as an independent producer:

```dotenv
PROMOTIONS_READ_MODE=legacy
PROMOTIONS_LEGACY_BASE_URL=https://padlhub.su
PROMOTIONS_HERO_PLACEMENT=cabinet_home
PROMOTIONS_STANDARD_PLACEMENT=cabinet_home
PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT=cabinet_for_me_strip
PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT=cabinet_for_me_card
# Same 32+ character secret in PadlHub API and CUP; never expose it to web clients.
PROMOTIONS_ENGAGEMENT_SECRET=<secret runtime value>
PROMOTIONS_SYNC_INTERVAL_MS=120000
PROMOTIONS_SYNC_BATCH_SIZE=20
PROMOTION_ROTATION_INTERVAL_SECONDS=6
PROMOTION_IMAGE_ALLOWED_HOSTS=padlhub.su
PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS=
PROMOTION_IMAGE_DESKTOP_MAX_WIDTH=1600
PROMOTION_IMAGE_DESKTOP_MAX_HEIGHT=900
PROMOTION_IMAGE_MOBILE_WIDTH=750
PROMOTION_IMAGE_MOBILE_HEIGHT=480
PROMOTION_IMAGE_WEBP_QUALITY=80
```

For local Docker and Jetson staging, migration `0049_promotion_media_private_http_sources.sql`
keeps the database source URL constraint aligned with the worker allowlist: HTTP is accepted only
for loopback, `host.docker.internal`, or the `phab-showcase` service name. The runtime must still
list the exact hostname in `PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS`.

For Jetson staging, `deploy/jetson/activate-live-home.sh` replaces the legacy public origin with
`http://phab-showcase:3000`, keeps both Home slots on CUP Block 2, and allowlists
`phab-showcase` for the staging-only private HTTP media copy. Production rejects any non-empty
`PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS`. The staging worker is attached to the external
`phab-showcase_default` network; absence of that network or an invalid
`GET /api/advertising/cabinet-home` response is a rollout NO-GO. Do not expose this private HTTP
origin to web/mobile clients and do not bypass the showcase Basic Auth from a browser.

Recreate only the worker after changing this gate. Verify a `promotion` row for the test user in
`home.dashboard_components`, then verify that its payload contains only PadlHub UUIDs and signed
PadlHub object URLs. Toggle or reorder a card in CUP and wait one sync interval; the Home snapshot
revision must advance without a browser request to `/api/advertising/cabinet-home`. Roll back by
setting `PROMOTIONS_READ_MODE=mock` outside production or by promoting the previous worker image;
the last valid projected component remains readable until explicitly replaced.

For recommendation cards, verify both media siblings before enabling the placement: the square
source must render as `178 x 178` in the compact Home V3 grid and the horizontal source as
`335 x 164` in the vertical list. They must resolve to separate PadlHub object URLs even when an
operator initially uploads the same file for both variants. A successful worker health check alone
does not prove that both media records survived garbage collection.

Engagement collection additionally requires the same secret in CUP as
`ADVERTISING_ENGAGEMENT_SECRET`. Recreate the API and CUP processes after injecting it. Smoke-test
with an authenticated test user: hold a card at least 50 percent in view once, then click it. The
protected CUP insights endpoint for `cabinet_for_me_card` must advance impressions and clicks by
one, and the click group must contain that user's full E.164 phone. Re-rendering without leaving the
page must not add another impression; replaying the same idempotency key must not add another
event. Never print the phone list in deployment logs or include it in an unauthenticated response.

Verify source revisions and projector input without printing payloads:

```sql
select user_id, component, source_revision, fetched_at
from integration.viva_home_source_components
order by user_id, component;

select user_id, content_sha256, object_key, synced_at
from integration.user_profile_photo_sync
order by user_id;
```

Do not print `source_url`, storage credentials or historical signed query parameters during
verification. For a profile with a Viva photo, confirm that the `profile` component contains the
stable `/public/api/v1/media/profile-photos/{tenantId}/{deliveryId}` path and that a GET to that path returns
`image/webp`. A second unchanged cycle must not create another object. Changing the Viva photo must
produce a new SHA-256 object key and retire the previous key only after the database/outbox
transaction succeeds.

`EXTERNAL_ID_MAPPING_CONFLICT` means the Viva profile is already attached to another PadlHub UUID.
Do not edit the mapping or revoke a delegation as an implicit repair; stop for explicit account
linking/merge review. Transient failures observe the configured backoff, bounded GET retry and
circuit breaker.

## Switch and verify

Set the API environment and recreate only the API process:

```dotenv
HOME_READ_MODE=projection
HOME_PROJECTION_MAX_STALE_SECONDS=300
HOME_PROJECTION_TTL_SECONDS=300
```

```bash
docker compose up -d --force-recreate api
curl -fsS http://127.0.0.1:3000/health/ready
```

Using a valid PadlHub user JWT, verify that `GET /user/api/v1/{tenantKey}/home` returns 200,
`snapshot.source=LOCAL_PROJECTION`, the expected `snapshot.version`, `X-Correlation-ID`, and no
external identifiers. Confirm that the browser performs one Home request and renders the same
version.

For a HomeBase-capable client, additionally verify that `GET /user/api/v1/{tenantKey}/home/base`
returns the expected snapshot version and explicit community/promotion section states. Browser
network evidence must show one PadlHub HomeBase read, the separately routed self-profile read and,
when rendered, the separate PadlHub notification-badge read. It must not show direct Viva bookings
or subscriptions, and no section may silently fall back between PadlHub and Viva.

### Jetson staging activation

The staging Compose file reads `/etc/phub/staging.env` first and an optional non-secret
`/opt/phub/staging.override.env` second. The deploy workflow runs
`deploy/jetson/activate-live-home.sh`, which writes only the Home/community/promotion feature gates
to that override. Secrets remain exclusively in `/etc/phub/staging.env`.

The activation is deliberately two-phase. It recreates the worker while Home reads stay on mock
and temporarily raises the promotion batch to 100 so active delegated users are covered within the
bounded activation window. It then requires every active Viva delegation to receive fresh Viva,
community and promotion source components, three fresh canonical platform components, a canonical
locations component and a fresh complete `LOCAL_PROJECTION` snapshot. Only after that database gate
passes does it write `HOME_READ_MODE=projection` and recreate both API and worker from the persistent
projection override. If the gate times out, the script prints only aggregate component readiness,
restores the previous persistent read mode, recreates the worker from that mode and exits without
changing the running API mode.

## Failure and rollback

- `HOME_PROJECTION_NOT_READY`: fill the tenant/user row; do not enable a mock fallback.
- `HOME_PROJECTION_INVALID`: stop the producer, inspect contract validation logs and import a higher
  corrected revision.
- `HOME_PROJECTION_STALE`: restore the producer and publish a fresh higher revision. Increasing the
  stale grace is an approved incident mitigation only when the business accepts stale data.
- HomeBase `STALE`: confirm the section `revision`, `observedAt`, `staleAt` and approved maximum
  stale window, show a visible stale treatment, and restore its owner. Never rewrite freshness
  metadata without a new source event.
- HomeBase `UNAVAILABLE`: keep the failure section-scoped and restore/backfill its local owner. Do
  not substitute mock or a browser-relayed Viva payload.
- `PROFILE_PHOTO_*`: inspect the redacted worker error code, CDN allowlist, image limits and object
  storage readiness. The worker keeps the last stored avatar and continues the Home batch; do not
  replace it with the Viva URL in the public projection.
- In local/CI only, set `HOME_READ_MODE=mock` to continue interface development. Production rejects
  that configuration. Production rollback uses the verified previous image digest and preserves the
  projection table for inspection/replay.
- Messages with invalid contracts or revision conflicts go to `phub.dead-letter`. Transient
  failures are requeued by the quorum queue and dead-lettered after the bounded delivery limit.
