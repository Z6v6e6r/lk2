# Jetson Nano staging

The Jetson Nano is an ARM64 staging node, not a build host. CI builds the
application images once for `linux/arm64`, publishes them, and deploys the
resulting digests. The node only pulls images by digest and runs Compose.

Staging deployment is manual-only. Run `Build and deploy staging` with
`workflow_dispatch` from the `main` branch and enter the exact
`deploy_confirmation=DEPLOY_STAGING` value. The validation job fails before checkout/build when the
confirmation is absent or different, the selected ref is not `main`, no operation is selected, or
deployment confirmation is mixed with either diagnostics option. `diagnose_home=true` with an
empty confirmation runs only the independent Home/public-ingress diagnostics. The stricter
`diagnose_media=true` mode rejects `recover_udisks=true` outright, so its evidence cannot include a
service restart or another staging write.
Set `diagnostic_phone_last4` to one to ten comma-separated four-digit phone suffixes to add a
read-only, redacted test-player check. It reports only the masked suffix, PadlHub user UUID, account
and Viva-delegation status, refresh timestamps/error codes, and Home projection freshness. The
diagnostic never reads token ciphertext or Viva subject values and forces a read-only PostgreSQL
transaction.
Use `deployment_profile=FULL_LIVE_HOME` for the existing routing refresh and guarded Live Home
activation. Use `deployment_profile=CLIENT_ASSISTED_VIVA` when Viva server-side Home reads remain
blocked but the browser-origin read-job contract is ready. This profile applies the same audited
tenant routing envelope, enables `VIVA_DIRECT_READ_ENABLED`, explicitly disables
`HOME_VIVA_SYNC_ENABLED` and the legacy Viva Home Game bridge, and preserves the current
`HOME_READ_MODE`. It then restarts only API and worker, proves the exact Nano-origin Viva CORS
contract, verifies all active target-tenant delegations can receive the routing envelope, and
fails if another active tenant would enter mixed mode through the global kill switch. It covers
recommendations, group-training and event schedules, upcoming bookings and activity history
without waiting for server-to-server Viva profile or schedule egress.

Use `deployment_profile=COMMUNITIES_LEGACY_READ_ONLY` to deploy the authenticated legacy
Communities directory, detail, feed, chat and rating projections without refreshing client routing
or activating Viva Live Home. Leave every routing and messaging-player input empty. The profile
uses the ordinary immutable-image, application-backup, PostgreSQL-backup, migration, TLS, health
and smoke pipeline. Before application readiness it starts only web and API and keeps worker and
realtime stopped. Its activation atomically changes only the API-specific Communities read mode,
four default-off read capabilities and bounded legacy-client settings, then recreates only API. It
fails and restores the previous API profile and process state if readiness or exact runtime
verification fails. It does not authorize canonical
Communities writes, media upload/processing, invites, realtime ownership, imports, cutover or
production.

Use `deployment_profile=MESSAGING_TEST` only for the isolated two-player chat contour;
provide two distinct active PadlHub UUIDs in `messaging_player_a_id` and
`messaging_player_b_id` and leave every routing input empty. This profile still builds and promotes
the same immutable digests, takes application and PostgreSQL backups, migrates, validates TLS and
runs the ordinary smoke suite. It skips routing refresh, Live Home activation, full live-Home data
and CUP gates. Instead it proves the saved `staging.override.env` is byte-identical, migration 0057
has the repository checksum, both players retain chat permission/privacy, the anonymous
conversation boundary returns `AUTH_REQUIRED`, and realtime readiness reports PostgreSQL, Redis
and RabbitMQ ready. Any failure invokes the same application rollback.

Use `deployment_profile=CHAT_PUSH_FOUNDATION` only for the reviewed, default-off 0069–0073
initial maintenance window when exactly those five migrations are pending. It requires the
explicitly attested `staging-foundation-maintenance`
Environment, an allowlisted actor, exact candidate and active-release SHAs, the complete tenant
inventory and the explicit no-booking-producer attestation. It preserves the current
authentication, Home, Communities and Games files; skips routing, ingress, activation, CUP and
promotion; drains API/worker/realtime before the final database backup and one-shot migration; and
starts the candidate API, worker, realtime and web sequentially. The exact operational sequence,
stop conditions and post-marker recovery rule are in
[Chats, notifications and moderation rollout](chats-notifications-moderation.md#dedicated-staging-foundation-profile).
After an irreversible phase marker, use only
`deployment_profile=CHAT_PUSH_FOUNDATION_RECOVERY` with the exact
`RESUME_CHAT_PUSH_FOUNDATION_STAGING` confirmation, original first-attempt run ID and its retained
backup. That path reuses the original database backup, candidate digests, clone-derived catalog
digest and monitoring digest; it revalidates the backup's stored path, byte size, SHA-256 and
`pg_restore --list`, but never restores the database, creates another clone or starts the old
writers. Before installing candidate definitions, monitoring or the overlay, the workflow calls the
already installed helper in compare-only `prepare-recovery` mode and invalidates any prior healthy
phase. An external smoke
failure after candidate runtime verification leaves the candidate running and records
`EXTERNAL_SMOKE_FAILED` only after the active release, health and immutable digest of API, worker,
realtime and web are rechecked for this same protected recovery path.
This repository currently uses the staging-only `solo-owner` exception documented in that runbook:
the Environment has no independent reviewer, but is restricted to `main`, disables administrator
bypass, requires the exact solo-owner readiness value, and binds both the sole-owner ID and operator
allowlist to the repository owner. This is an explicit reduction in human separation of duties, not
a production precedent. It never authorizes a provider call or feature activation, and every
technical foundation gate remains mandatory.

If the staging runtime env metadata preflight fails, use the isolated
`foundation_runtime_env_repair_confirmation=REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS` operation from
`main` before any diagnostic or deployment. It is gated by the same solo-owner Environment and
changes only `/etc/phub/staging.env` ownership and mode; it does not read values, run Compose or
migrate the database.

An isolated staging user-access change uses the same workflow with `access_target_user_id`,
`access_actor_id`, and the complete `access_roles` and `access_permissions` sets. It cannot be
combined with deployment or diagnostics. The workflow always previews current versus desired
access first; applying additionally requires `access_apply_confirmation=APPLY_USER_ACCESS`. The
operator locks the target row and records `USER_ACCESS_CHANGED` with old/new JSON in the audit log.
The same read-only mode fingerprints the repository `0057_messaging_runtime.sql` migration and
reports only structural PostgreSQL metadata for its three tables: matching migration-journal rows,
columns, constraints, indexes, RLS flags and policies. The remote `psql` session enforces both
`default_transaction_read_only=on` and `BEGIN READ ONLY`; it does not inspect tenant rows or change
the migration journal. Use this evidence before reconciling a legacy renamed migration.

If the diagnostic proves that `0043_messaging_runtime.sql` has the exact repository `0057`
checksum and that all expected messaging relations, columns, constraints, indexes, RLS flags and
policies exist, `0056_messaging_runtime_legacy_alias.sql` records the checksum-identical `0057`
filename in `public.schema_migrations`. Fresh databases and databases without that exact legacy
journal row are unchanged by `0056` and proceed through the ordinary `0057` DDL. A mismatched
legacy/current checksum or incomplete security structure fails the migration; do not delete or
rewrite migration-journal rows manually.

Node services keep their runtime dependencies external to their ESM output.
This is required for OpenTelemetry's Node instrumentation, which uses dynamic
module loading and cannot run from an esbuild-bundled ESM artifact. Each
immutable image therefore contains the compiled service and its production
dependency tree.

## Network boundary

- Public WAN forwarding targets only Nginx on ports 80 and, after a domain and
  certificate are configured, 443.
- PostgreSQL, Redis, RabbitMQ, MinIO, OTLP, Prometheus, Grafana and Portainer
  are private Docker-network services. The three management UIs bind to
  loopback and are accessed through Tailscale plus SSH tunnelling.
- The Nano is reachable in the tailnet as `phub-jetson-staging`.

## Bootstrap

1. Copy `deploy/jetson` to `/opt/phub` on the Nano.
2. Generate `/opt/phub/infrastructure.env` locally on the Nano. It contains
   only host secrets and resolved image digests; never commit it.
3. Validate and start the infrastructure:

   ```sh
   cd /opt/phub
   docker compose --env-file infrastructure.env -f compose.infrastructure.yaml config --quiet
   docker compose --env-file infrastructure.env -f compose.infrastructure.yaml up -d
   ```

4. Before application deployment, verify the backup destination and populate
   `/etc/phub/staging.env` plus `/etc/phub/staging.migrator.env`. Run migrations once from the
   CI-published migrator digest. Its preflight must confirm distinct unmasked login roles, a
   DDL-free runtime role and a bounded migrator role on the same writable primary; only then deploy
   web, API, realtime and worker.

The application runtime uses separate API/worker and realtime secret contours:

- `/etc/phub/staging.env` is mode `0600`, owned by `phub-deploy`, and contains the API/worker
  runtime secrets, including access/refresh signing keys;
- `/etc/phub/realtime.env` is mode `0600`, owned by `phub-deploy`, and contains only the common
  database/broker metadata plus `JWT_REALTIME_SECRET`; access/refresh signing keys are forbidden;
- `/opt/phub/staging.auth.env` is mode `0600`, owned by `phub-deploy`, and contains the audited
  authentication gates plus `HOME_BASE_SYNC_ENABLED=true`. Ordinary deploy profiles rewrite this
  non-secret file atomically before preflight so OAuth recovery and the local HomeBase projector
  cannot drift from the working local contour. Both chat/push foundation profiles and
  `MEDIA_BINARY_ONLY` are exceptions: they fingerprint, snapshot/reuse where applicable, and
  preserve this file byte-for-byte;
- `/opt/phub/staging.override.env` contains only the Home/community/promotion live-read gates;
- `/opt/phub/staging.games.env` is mode `0600`, owned by `phub-deploy`, and contains the
  staging-only Games mirror gates. The Mongo mirror keeps its URI only here.
- `/opt/phub/staging.chat-push-foundation.env` is an optional mode-`0600`, API/worker-only,
  final-precedence maintenance overlay. During the foundation profile it contains exactly the three
  global false kill switches documented in the chat/push runbook. It is never attached to realtime,
  migrator or web, and application backup/rollback preserves both its present and absent state.

The migrator file is not part of the application runtime environment. It must be mode `0600`, be
readable by `phub-deploy`, and contain exactly one non-comment setting: `DATABASE_URL`. That URL
uses the reviewed DDL role required by the migration ledger and current migrations. It must differ
from the runtime `DATABASE_URL`; API, worker, realtime and web containers never receive it. The
deploy workflow rejects a missing file, extra keys, duplicate/malformed URLs, the same file inode or
the same URL before it starts the digest-pinned migrator. The migrator image then verifies the
actual PostgreSQL identities and privileges for both URLs without logging their values. Provision
and rotate this file through the host secret-management procedure, never through Git or a workflow
artifact.

The staging `web` service is a static nginx image and receives no runtime env file. Database, JWT,
Viva, object-storage and provider credentials are available only to the server process that owns
the corresponding operation; never add the shared runtime anchor back to `web`.

The Games file must select the Mongo source, enable canonical Games reads and Activity History
game backfill, and keep commands disabled until their separate cutover approval. The deploy
workflow verifies a bounded read from the `games.lk_games` collection without logging source
records or the URI. It runs
`verify-live-staging-data.sh preflight` before backup/migration and repeats the verification after
the new containers start. A release fails if Viva/Home uses mock data, if a local dev-auth path is
enabled, if API and worker do not share the `phub-media` bucket, or if the worker does not produce
real canonical Games, card projections and guarded roster-mirror state.

The runtime override contains independent Home-source and browser-transport gates. Full Home sets
both `HOME_VIVA_SYNC_ENABLED=true` and `VIVA_DIRECT_READ_ENABLED=true` only after every source
projection becomes fresh. `CLIENT_ASSISTED_VIVA` instead keeps server Home Viva sync off and turns
on only the browser transport. The staging auth environment explicitly pins
`VIVA_END_USER_API_URL=https://api.vivacrm.ru/end-user/api` so the application and the CORS
preflight verifier use the same provider boundary instead of relying on a package default. Before
either activation, every target-tenant user with an active
Viva delegation must have a `MIXED_END_USER_READS` routing plan with `profile.read`, plus a
non-empty Viva provider tenant binding. Fixed schedule, upcoming-booking and history commands use
that mixed plan as their transport envelope; they are not added to the general direct-operation
allowlist. Activation and post-deploy verification fail when an active delegation cannot receive
the envelope. The full-Home override additionally bounds the synchronous legacy community bridge
to one 2.5-second attempt and keeps successful pages for two minutes; optional member-rank
enrichment has a 150 ms response budget. It explicitly enables the four independent, read-only
legacy community projections (`DETAIL`, `FEED`, `CHAT`, and `RATING`) only during the guarded
Full Live Home activation. They remain default-off in every other profile. The post-activation
verifier checks all four values both in the effective runtime files and inside the API container;
none of these gates enables community commands, media uploads, invites, canonical writes or
realtime ownership.

`COMMUNITIES_LEGACY_READ_ONLY` is a separate, non-promotable preview profile. Its flags live only
in `/opt/phub/staging.communities.env`, an optional env file attached to API and never to worker,
realtime or migrator. Activation stops worker and realtime, requires media, invites and realtime
flags to be false, pins `COMMUNITIES_LEGACY_BASE_URL=https://padlhub.su` inside that API-only file
instead of inheriting the internal Full Live Home source, probes that HTTPS legacy summary
endpoint, then signs a 60-second in-memory JWT for an
existing active PadlHub identity and discards the authenticated community-detail response. It does
not create identities or mappings and never logs the token or provider payload. A failed activation
restores the previous API env file and the previous worker/realtime process state, then proves API
readiness; failure to restore remains a failed deployment and invokes the full application rollback.

`MEDIA_BINARY_ONLY` is a non-promotable expand-release profile. It requires the exact currently
serving 40-character release as `expected_active_release` and never refreshes routing, activates
Home/client-assisted/legacy modes, rewrites runtime override files, or stops worker/realtime as a
profile side effect. Before CI builds or pushes an image, the `media-baseline` job streams reviewed
scripts over SSH stdin and performs only read-only PostgreSQL, Docker, filesystem, capacity and S3
checks. It binds a redacted artifact to the active release, candidate SHA/tree, immutable running
images, runtime/routing fingerprints, full migration manifest and cause-aware rollback floor.
Unknown/mismatched migration ledger rows, enabled profile/community media flags, missing or
content-hash-mismatched referenced objects, destructive lifecycle rules, active lock waits, swap
activity, OOM or excessive memory PSI fail closed. This profile is deliberately pre-cutover only:
it accepts the ordinary or client-media rollback floor and rejects an active stable community-logo
cutover.

Run the same baseline without a deploy confirmation first:

```sh
gh workflow run deploy-staging.yaml --ref main \
  -f deployment_profile=MEDIA_BINARY_ONLY \
  -f diagnose_media=true \
  -f expected_active_release=<currently-serving-40-character-release>
```

An actual `MEDIA_BINARY_ONLY` dispatch additionally requires `deploy_confirmation=DEPLOY_STAGING`.
The staging migration ledger must already contain every packaged migration through
`0078_community_media_issue_quotas.sql`; the only approved pending suffix is `0079`, `0080`, and
`0081` in that order. Older Communities migrations are a separate rollout and must never be hidden
inside this media-binary profile. It re-runs the baseline immediately before the application
snapshot, binds that snapshot back to `expected_active_release`, proves a real restore and two
candidate-migrator invocations (the second must apply nothing) on an isolated local PostgreSQL 16
database, and only then mutates the shared schema with bounded SQL deadlines. The retained archive
contains owner and ACL metadata. The generic restore verifier may apply it portably without owners,
but the separate media clone restores the exact same-cluster ownership/ACL boundary, runs the
`media` split-role verifier before and after migration, and executes a rolled-back runtime DML/RLS
probe bound to the exact active `local-padel` staging tenant. The bounded migrator must already own
both altered media mapping tables, and its
schema-local `integration` default ACL must grant the exact runtime role only
`SELECT/INSERT/UPDATE/DELETE`; `PUBLIC`, grant options, global defaults and third grantees block the
profile.
API is rolled first while the previous web/worker/realtime remain serving; existing profile-photo
and community-logo objects must return `image/webp` both directly and through canonical Caddy/Nginx
HTTPS before worker. Worker and realtime follow one at a time. Candidate Nginx is then recreated
and rechecked while the old web manifest is still serving; web follows last, and the promoted Caddy
path is checked again against the candidate manifest. Runtime files and the
effective running operational environment must match before rollout and remain unchanged after it.
The retained artifact includes the application-snapshot release, PostgreSQL archive checksum,
post-pull disk budget, clone duration, no-op rerun, exact ledger and confirmed clone cleanup. Both
stable-logo flags, client profile sync, community media, invites and Communities realtime remain
explicitly false, so this profile changes no user-visible media URL. Feature enablement is a later,
separately approved operation.

Only a successful `FULL_LIVE_HOME` run writes the three-line
`production-promotion-eligibility.env` artifact bound to its release SHA and workflow run ID.
Production refuses every staging run without that exact artifact, so this lightweight Communities
profile can never certify image digests for promotion.

The post-deploy gate also reads the public coach-game and tournament discovery contracts through
the running API with a six-second deadline. `health/ready` is not evidence for these upstreams:
coach-game discovery requires the configured Viva end-user schedule source to accept the Nano API
read, and tournament discovery requires `LEGACY_GAMES_PUBLIC_BASE_URL/api/tournaments` to respond
within that budget. A `COACH_GAME_DISCOVERY_UNAVAILABLE`, `TOURNAMENT_DISCOVERY_UNAVAILABLE`, HTML
fallback or timeout fails the release even when the containers remain healthy.

Every confirmed staging deployment creates a PostgreSQL custom-format archive under
`/opt/phub/backups/postgres-pre-<release>-<UTC timestamp>.dump`. The workflow
requires a non-empty private mode-0600 archive, records its size and SHA-256, validates its TOC,
then restores the complete archive with `pg_restore --exit-on-error` into a clean temporary database
on the same PostgreSQL 16 cluster. It requires the restored migration ledger to be queryable and
drops the temporary database before running the digest-pinned migrator against staging. The workflow
then confirms the latest repository migration in `public.schema_migrations` before it switches
application containers. After pulling images and before creating the archive, it records the source
database size and requires free disk headroom equal to three database copies plus 1 GiB for the
archive, restored clone, WAL and temporary overhead. It repeats that check after the private archive
exists, before the restore or shared-target migration. The backup directory is a non-symlink
directory owned by the deploy user with mode 0700; archives are created exclusively with `mktemp`.
A failed capacity check, backup, restore or migration leaves the currently running application
release untouched.

For `MEDIA_BINARY_ONLY`, the generic full-archive restore check remains mandatory and is followed
by a second media-specific rehearsal against another non-existing isolated PostgreSQL 16 database
on the same approved local server. That rehearsal runs the exact candidate migrator twice, requires
the second invocation to apply nothing, verifies the complete filename/checksum ledger plus the
exact media constraint and RLS-policy invariants, and strictly drops and reads back absence of its
clone before the shared schema is touched.

Each restore verification or rehearsal owns only a database it created successfully. It writes a
`CANDIDATE` marker before `createdb`, replaces it with `OWNED` only after creation is acknowledged,
and removes `/opt/phub/backups/.restore-cleanup-<database>` only after the temporary database is
confirmed absent. A leftover marker blocks the next verification. Inspect the exact marked
database, drop only that database through the approved PostgreSQL administration path, and remove
the marker only after the drop is independently confirmed. Never delete a colliding unmarked
database.

Before pulling a new digest, CI checks free space on `/`. `MEDIA_BINARY_ONLY` additionally derives
the required headroom from the live database size for the retained dump, restored clone, WAL,
candidate images and safety reserve, then repeats the dynamic disk budget after image pull. Below
8 GiB the generic deploy path removes only Docker
images that are not referenced by a container; it never prunes volumes. Deployment stops before
pull/migration if that safe cleanup still leaves less than 4 GiB. A Redis
`MISCONF ... stop-writes-on-bgsave-error`, PostgreSQL restart loop, or RabbitMQ `541` must therefore
be treated as a storage incident first: inspect `df -h /`, `df -i /` and `docker system df`, retain
all volumes, free only confirmed-unused images, then require all three infrastructure healthchecks
before restarting the application release.

The staging application Compose file passes the existing MinIO credentials from
`infrastructure.env` into API and worker. Both use the same private `http://minio:9000` endpoint
and `phub-media` bucket: worker owns writes while API serves stable profile-photo delivery routes.
Realtime does not receive object-storage credentials. The bucket is not public; direct unsigned
S3 reads must remain denied.

## GitHub Actions access

GitHub-hosted runners reach the private Nano through the Tailscale action, not
through a public SSH forward. In the tailnet, create `tag:ci` and allow it to
reach `phub-jetson-staging:22`. On plans without Tailscale OAuth clients, use a
reusable, ephemeral 90-day auth key that is tagged `tag:ci`; rotate it before
expiry. Configure these GitHub environment `staging` secrets:

- `TAILSCALE_AUTHKEY` for the tagged, reusable, ephemeral Tailscale auth key;
- `STAGING_HOST=100.70.62.47`;
- `STAGING_DEPLOY_KEY`, the dedicated `phub-deploy` private key;
- `STAGING_KNOWN_HOSTS`, the Nano host key for `100.70.62.47`.

The separate `staging-foundation-maintenance` Environment owns no deployment secrets; the deploy
job still receives those only from `staging`. It supplies the reviewed readiness attestation and
singleton owner/operator IDs described in the chat/push runbook. Under the explicitly approved
staging-only `solo-owner` exception it has no required reviewer, restricts deployments to `main`,
disables administrator bypass, and relies on the workflow to require the exact repository-owner
login and numeric actor ID. This reduced separation of duties is not a production precedent.
Every third-party Action used by the foundation path must be pinned to a reviewed full commit SHA
before this Environment is marked ready; a mutable `@vN` reference is a release stop condition.

The staging workflow joins the tailnet as an ephemeral `tag:ci` node, verifies
the Nano with Tailscale ping, then uploads the digest-pinned release definition and the non-secret
public media endpoint.
It uses the job-scoped `GITHUB_TOKEN` only through standard input to pull the
GHCR image digests and logs the Nano out of GHCR immediately afterward. Do not
create or store a long-lived registry token on the node.

After switching containers, the workflow waits until Docker reports API, realtime and worker
healthchecks as `healthy` before the public smoke test. The container healthchecks call each
process's private readiness endpoint, so the deploy gate does not depend on a second ad hoc command
inside a running container. If readiness does not converge, the workflow prints bounded startup
logs and container status, then fails the release instead of reporting an ambiguous Nginx `502`.

When a Viva OAuth callback returns `AUTH_PROVIDER_UNAVAILABLE`, find the callback by correlation ID
in the API logs and inspect the following redacted `identity provider operation` metric. Its
`failureStage` distinguishes the token request/payload, refresh credential, access-token validation
and Viva profile request/response/payload without logging an authorization code or provider token.
If a server-side profile response is `403`, staging may set
`VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED=true` only while keeping
`VIVA_DIRECT_READ_ENABLED=false`. The deploy verifier enforces both values. The fallback accepts
only an already-linked `(tenant, issuer, subject)` and fails closed with
`AUTH_IDENTITY_LINK_REQUIRED` for an unknown subject.

After the immutable services start, `verify-home-base.sh` waits until every active user with a
current Viva delegation has a fresh `home.base_snapshots` row. The worker prioritizes this bounded
set ahead of the full identity backfill. In addition, an authenticated `/home/base` read provisions
its own missing PadlHub-only projection synchronously, so a newly authenticated user never waits for
the background batch cursor. The deploy gate validates the persisted snapshot contract and a recent
`checked_at` watermark; optional-section TTLs are normalized separately at read time. This gate runs
before the independent Viva-backed full Home activation.

## Application rollback snapshot

Before switching an application release, the confirmed deployment creates one mode-`0700` child
directory under `/opt/phub/backups/releases`. The backup primitive requires the exact previous `compose.yaml` and
`release.env`; the release file must resolve web, API, worker, realtime and migrator only through
full `sha256` digests. The snapshot must also contain `nginx/default.conf`, `staging.auth.env` and
`tls-ingress/Caddyfile`. It stores either the previous `staging.override.env` or an empty
`staging.override.env.absent` marker, and independently stores `staging.communities.env` or its
empty `.absent` marker. It also stores `staging.games.env` and
`staging.chat-push-foundation.env` or their empty `.absent` markers, plus a
`worker-capabilities.env` attestation tied to the running API/worker digests. Write
`backup.complete` last with the exact previous release SHA.

The expected saved-release layout is:

```text
/opt/phub/backups/releases/pre-<candidate-sha>-<workflow-run>-<attempt>/
  compose.yaml
  release.env
  nginx/default.conf
  staging.auth.env            # mode 0600
  staging.override.env        # mode 0600; or staging.override.env.absent
  staging.communities.env     # mode 0600; or staging.communities.env.absent
  staging.games.env           # mode 0600; or staging.games.env.absent
  staging.chat-push-foundation.env # mode 0600; or matching .absent marker
  worker-capabilities.env     # API/worker community-logo rollback attestation
  process-state.env           # exact running/stopped state for web, API, worker and realtime
  tls-ingress/Caddyfile
  backup.complete             # exact release SHA, written last
```

After declaring an incident, stopping concurrent deployments and confirming that the previous
binary remains compatible with the expanded schema, invoke the reviewed on-host copy of the script
with that explicit directory:

```sh
PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/rollback-application.sh \
  /opt/phub/backups/releases/pre-<candidate-sha>-<workflow-run>-<attempt> \
  --confirm=ROLLBACK_STAGING_RELEASE
```

`rollback-application.sh` rejects paths outside `/opt/phub/backups/releases`, symlinked saved files, mutable
image references, incomplete snapshots, malformed release metadata and Compose definitions that do
not resolve exactly the five recorded image digests. It requires all four old runtime images to
already exist locally before changing files, stores
the displaced current files in a new `rollback-recovery-*` directory, restores saved files with
restricted modes, and never starts the migrator or reverses an expand migration. It validates and
recreates both Nginx and Caddy. Success is
reported only after private `/health/ready` checks pass inside API, realtime and worker containers.
The script never prints `release.env`, `staging.auth.env` or their values. For malformed
`release.env` input it reports only the line number, a validated uppercase key (or a redacted key
classification) and the line length. Values are restricted to printable ASCII under `LC_ALL=C`, so
validation behaves consistently across the developer and Jetson `awk` implementations. The
read-only diagnostics workflow runs the same metadata-only inspection against
`/opt/phub/release.env` and continues with the remaining host checks even when the metadata
inspector finds an invalid line.

Rollback validation enables the Compose `migration` profile only for `docker compose config`, so
the saved migrator digest is included in the exact five-image check. Rollback itself never runs the
migrator and restores only `web`, `api`, `worker` and `realtime`; applied expand-only migrations are
not reversed.

If validation, image resolution or readiness fails, retain both saved-release directories, stop the
change window and inspect only redacted container status. Do not delete the expanded schema and do
not repeatedly alternate releases. The primitive must be copied to `/opt/phub` and the snapshot
must be created by the deployment workflow before it can be considered an operational rollback
path. The primitive never uses registry credentials or pulls images. After a snapshot succeeds, any
later failed or cancelled workflow step invokes rollback automatically. The database is not rolled
back: the verified custom-format archive is retained and expand migrations remain applied. Before
the workflow marks the snapshot rollback-ready, `--validate-only` proves its Compose/digest set and
the local availability of every previous runtime image without changing the active release.

## Application ingress

Nginx stays healthy before the first application release. After a web release,
it serves the PadlHub SPA from `/` and falls back to `index.html` for client
routes. It also exposes these application routes:

- `/health` and `/health/*` to the API;
- `/public/api/*` to the anonymous read-only API;
- `/user/api/*` to the API;
- `/admin/api/*` to the authenticated CUP Admin API;
- `/realtime/*` to the realtime service, including WebSocket upgrades.

`/internal/api/*` is intentionally not exposed by the public Jetson ingress. The deploy smoke test
requires JSON plus stable API error codes from both the Public and Admin boundaries, so an HTML SPA
fallback cannot be accepted as a healthy API route.

Canonical TLS promotion validates the candidate Caddyfile before recreating Caddy. After recreation,
the workflow polls both `/health/ready` and `/realtime/health/ready` through
`lk.nano.padlhub.su` on the local TLS listener. The gate allows at most 15 attempts separated by two
seconds, with bounded connect and request timeouts. It promotes the ingress only when both routes pass
in the same attempt; exhaustion logs one final probe for each route and restores the saved Caddyfile.

The web image is built in CI for `linux/arm64`, pinned by digest in the release
file, and served by an internal Nginx container. The Jetson never builds the
client and has no direct web-container port published. CI passes the deployed
commit SHA into the web build as `PHUB_RELEASE`; the post-deploy gate reads
`/manifest.json` through public ingress and requires its `release` field to
match the same GitHub commit before the release can succeed.

## Management access

With Tailscale connected, create local tunnels from the Mac:

```sh
ssh -N \
  -L 9443:127.0.0.1:9443 \
  -L 3101:127.0.0.1:3101 \
  -L 9090:127.0.0.1:9090 \
  phub-deploy@phub-jetson-staging
```

Then use `https://localhost:9443` for Portainer, `http://localhost:3101` for
Grafana and `http://localhost:9090` for Prometheus.

Swagger UI and Editor stay loopback-only as well: `http://localhost:18080` and
`http://localhost:18082`. UI request execution and authorization persistence
are disabled; Editor mounts a read-only copy of the contracts.
