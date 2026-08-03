# Jetson Nano staging

The Jetson Nano is an ARM64 staging node, not a build host. CI builds the
application images once for `linux/arm64`, publishes them, and deploys the
resulting digests. The node only pulls images by digest and runs Compose.

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

Every staging workflow creates a PostgreSQL custom-format archive under
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

For an urgent web-only recovery, the staging workflow accepts `web_only_digest`
and its matching `web_only_release` commit only for an already-built `sha256:`
digest. That path backs up `release.env`,
replaces only `WEB_IMAGE_DIGEST`, pulls and recreates only the stateless `web`
service, then requires its Docker healthcheck and the loopback TLS manifest
release to match the workflow commit. It does not run migrations or restart the
API, worker, realtime, ingress, or infrastructure services. Use the normal full
rollout whenever any non-web artifact or release invariant changed.

If the canonical LK renders but session refresh fails with `ORIGIN_NOT_ALLOWED`, dispatch the
staging workflow with `repair_lk_origin=true`. The recovery preserves the currently resolved CORS
origins, adds the canonical LK and CUP origins, backs up `staging.auth.env`, and recreates only the
API container. It rolls the file back if API readiness or the unauthenticated refresh contract does
not converge; success requires `AUTH_SESSION_REVOKED` with the canonical CORS response header.

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
