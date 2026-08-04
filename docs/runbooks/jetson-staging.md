# Jetson Nano staging

The Jetson Nano is an ARM64 staging node, not a build host. CI builds the
application images once for `linux/arm64`, publishes them, and deploys the
resulting digests. The node only pulls images by digest and runs Compose.

Staging deployment is manual-only. Run `Build and deploy staging` with
`workflow_dispatch` from the `main` branch and enter the exact
`deploy_confirmation=DEPLOY_STAGING` value. The validation job fails before checkout/build when the
confirmation is absent or different, the selected ref is not `main`, no operation is selected, or
deployment confirmation is mixed with either diagnostics option. `diagnose_home=true` with an
empty confirmation runs only the independent read-only Home/public-ingress diagnostics; do not
combine it with `recover_udisks=true` when a strictly read-only run is required.
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
   `/etc/phub/staging.env`. Run migrations once from the CI-published migrator
   digest, then deploy web, API, realtime and worker.

The application runtime reads three environment files in order:

- `/etc/phub/staging.env` contains the root-owned shared runtime secrets;
- `/opt/phub/staging.auth.env` is mode `0600`, owned by `phub-deploy`, and contains the audited
  authentication gates plus `HOME_BASE_SYNC_ENABLED=true`. The deploy workflow rewrites this
  non-secret file atomically before preflight so OAuth recovery and the local HomeBase projector
  cannot drift from the working local contour;
- `/opt/phub/staging.override.env` contains only the Home/community/promotion live-read gates;
- `/opt/phub/staging.games.env` is mode `0600`, owned by `phub-deploy`, and contains the
  staging-only Games mirror gates. The Mongo mirror keeps its URI only here.

The Games file must select the Mongo source, enable canonical Games reads and Activity History
game backfill, and keep commands disabled until their separate cutover approval. The deploy
workflow verifies a bounded read from the `games.lk_games` collection without logging source
records or the URI. It runs
`verify-live-staging-data.sh preflight` before backup/migration and repeats the verification after
the new containers start. A release fails if Viva/Home uses mock data, if a local dev-auth path is
enabled, if API and worker do not share the `phub-media` bucket, or if the worker does not produce
real canonical Games, card projections and guarded roster-mirror state.

The Home override also enables the staging-only browser read-job transport. Before activation,
every tenant with an active Viva delegation must have a `MIXED_END_USER_READS` routing plan with
`profile.read`, plus a non-empty Viva provider tenant binding. Fixed schedule, upcoming-booking
and history commands use that mixed plan as their transport envelope; they are not added to the
general direct-operation allowlist. Activation and post-deploy verification fail when an active
delegation cannot receive the envelope. The same override bounds the synchronous legacy community
bridge to one 2.5-second attempt and keeps successful pages for two minutes; optional member-rank
enrichment has a 150 ms response budget.

Every confirmed staging deployment creates a PostgreSQL custom-format archive under
`/opt/phub/backups/postgres-pre-<release>-<UTC timestamp>.dump`. The workflow
requires a non-empty archive, validates it with `pg_restore --list`, runs the
digest-pinned migrator and confirms the latest repository migration in
`public.schema_migrations` before it switches application containers. A failed
backup or migration leaves the currently running application release untouched.

Before pulling a new digest, CI checks free space on `/`. Below 8 GiB it removes only Docker
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
`staging.override.env.absent` marker. Write `backup.complete` last with the exact previous release
SHA.

The expected saved-release layout is:

```text
/opt/phub/backups/releases/pre-<candidate-sha>-<workflow-run>-<attempt>/
  compose.yaml
  release.env
  nginx/default.conf
  staging.auth.env            # mode 0600
  staging.override.env        # mode 0600; or staging.override.env.absent
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
