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

## Enable Viva source producers

Profile, upcoming Viva bookings and subscriptions can be filled continuously before changing the
API read mode:

```dotenv
VIVA_MODE=sandbox
VIVA_OAUTH_ENABLED=true
HOME_VIVA_SYNC_ENABLED=true
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
PROFILE_PHOTO_ALLOWED_HOSTS=.selcdn.ru
PROFILE_PHOTO_MAX_BYTES=8388608
PROFILE_PHOTO_MAX_DIMENSION=1024
PROFILE_PHOTO_WEBP_QUALITY=82
PROFILE_PHOTO_URL_TTL_SECONDS=3600
```

Keep the delegation encryption key only in the secret runtime environment. Recreate the worker so
Docker applies changed environment values. `S3_PUBLIC_ENDPOINT` must be reachable by the client;
it is used only to sign GET URLs, while `S3_ENDPOINT` remains the private worker-to-storage address.
Production bucket provisioning is an infrastructure step and keeps `S3_AUTO_CREATE_BUCKET=false`:

```bash
docker compose up -d --force-recreate worker
docker compose exec -T worker node -e \
  "fetch('http://127.0.0.1:3002/health/ready').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

Verify source revisions and projector input without printing payloads:

```sql
select user_id, component, source_revision, fetched_at
from integration.viva_home_source_components
order by user_id, component;

select user_id, content_sha256, object_key, synced_at
from integration.user_profile_photo_sync
order by user_id;
```

Do not print `source_url`, signed query parameters or storage credentials during verification. For a
profile with a Viva photo, confirm that the `profile` component contains an `image/webp` signed URL,
that its host equals `S3_PUBLIC_ENDPOINT`, and that a second unchanged cycle does not create another
object. Changing the Viva photo must produce a new SHA-256 object key and retire the previous key
only after the database/outbox transaction succeeds.

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

## Failure and rollback

- `HOME_PROJECTION_NOT_READY`: fill the tenant/user row; do not enable a mock fallback.
- `HOME_PROJECTION_INVALID`: stop the producer, inspect contract validation logs and import a higher
  corrected revision.
- `HOME_PROJECTION_STALE`: restore the producer and publish a fresh higher revision. Increasing the
  stale grace is an approved incident mitigation only when the business accepts stale data.
- `PROFILE_PHOTO_*`: inspect the redacted worker error code, CDN allowlist, image limits and object
  storage readiness. The worker keeps the last stored avatar and continues the Home batch; do not
  replace it with the Viva URL in the public projection.
- In local/CI only, set `HOME_READ_MODE=mock` to continue interface development. Production rejects
  that configuration. Production rollback uses the verified previous image digest and preserves the
  projection table for inspection/replay.
- Messages with invalid contracts or revision conflicts go to `phub.dead-letter`. Transient
  failures are requeued by the quorum queue and dead-lettered after the bounded delivery limit.
