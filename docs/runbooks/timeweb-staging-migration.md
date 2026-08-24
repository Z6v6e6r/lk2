# Timeweb staging migration and Nano retirement

This runbook moves the complete staging/development contour from the Jetson Nano (blue) to the
Timeweb VPS (green). It does not authorize image publication, secret transfer, database access,
deployment, traffic switching, writes, service shutdown or deletion. Each state-changing gate needs
its own approval and evidence receipt.

## Completion contract

The migration is complete only when:

- Timeweb runs exact digest-pinned `linux/amd64` Web, API, Worker, Realtime and Migrator images;
- PostgreSQL, Redis, RabbitMQ, media storage, ingress and monitoring no longer require Nano;
- the separate CUP production migration has issued its independent completion receipt;
- CI deploy identity, known hosts and staging target point to Timeweb;
- authenticated API, media, realtime, worker, CUP and provider probes pass on Timeweb;
- off-host backup and isolated restore work without Nano;
- a 72-hour soak records no staging traffic to or from Nano;
- Nano staging services are stopped and their credentials revoked under a separate approval;
- destructive Nano cleanup happens only after the retention window and separate confirmation.

Target cutover is RPO 0 with a 90–180 minute maintenance window. Before the first accepted green
write, route-back to the frozen Nano should take 15–30 minutes. After the first green write, do not
route traffic to the stale Nano; recover forward on Timeweb or restore data under a new incident
plan.

## Invariants

1. Exactly one API contour accepts commands and exactly one worker/scheduler contour runs.
2. Migrator never runs concurrently and schema changes are outside the host move unless separately
   approved.
3. PostgreSQL is canonical business state. Redis is not canonical, and RabbitMQ is not a substitute
   for the PostgreSQL outbox/inbox.
4. PostgreSQL metadata and media objects share one write-freeze consistency point.
5. Blue remains pinned to `e308181d`/`0059` as the pre-write rollback contour; green is pinned to
   `35c8312`/`0088`. Compatibility must be rehearsed, and no hybrid image/schema pair is allowed.
6. Images use immutable digests. Do not use `latest`, rebuild on a host or dual-write storage.
7. Nano volumes and backups remain intact throughout cutover and soak.
8. New Communities, media, realtime or import capabilities are not activated during the host move.

## Selected application and schema target

The selected green candidate is
`main@35c8312b79cccdd136f2bfd892efbea629b8b919`, the exact source accepted by the reviewed amd64
publication workflow. It contains migrations through `0088_participation_command_foundation.sql`.
The Nano blue release is `e308181da5222645d9a87d03642923c6841be8d1` at recorded migration
`0059_game_conversations.sql`.

Therefore this is not a host-only move: migrations `0060` through `0088` form an explicit schema
forward gate. They must pass two isolated PostgreSQL 16 restore rehearsals, rerun idempotency,
ledger/RLS/constraint checks, old-blue compatibility analysis and independent migration review.
Neither image publication nor green provisioning authorizes that migration. If this target changes,
restart Gate 0 and review a new exact source/schema pair.

## Gate 0 — inventory and contract freeze

Pin `origin/main`, the current Nano release and all image digests. Run the inventory helper on each
host through the audited SSH identity and store the redacted output as operator evidence:

```sh
sh scripts/inventory-staging-host.sh blue
sh scripts/inventory-staging-host.sh green
```

The helper does not use `sudo`, enter containers, connect to databases or print environment values
outside the explicit release metadata allowlist. Confirm separately:

- blue and green use different dedicated keys and independently verified fingerprints in separate
  known-hosts files; clients require `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes`, disable
  password/agent/port forwarding and never trust an ambient SSH agent;
- Docker socket access is root-equivalent. Use the existing Docker-capable deploy identity only when
  its `authorized_keys` entry is constrained to a root-owned, hash-pinned forced-command wrapper for
  this exact helper and role, with no PTY, agent/X11/port forwarding or general shell. Do not create
  or describe Docker-group membership as read-only access;

- public DNS, TTL, NAT, UFW, Tailscale ACL/device, GitHub environment host/key/known-host bindings;
- Viva OAuth callback and new provider-egress allowlisting;
- the owner and deployment source for `cup-production-api`, `cup-production-proxy` and the
  `phab-showcase_default` network;
- PostgreSQL extensions/schema ledger and bounded aggregate counts;
- RabbitMQ definitions, ready/unacked/DLQ counts and outbox/inbox recovery contract;
- whether Redis contains revocation/session state that prevents a fresh start;
- MinIO bucket objects, versions, CORS, lifecycle and private-access policy.
- every writer identity and path: API/CUP commands, worker/schedulers, migrator, CI, provider
  callbacks, direct database roles, media credentials and operator sessions.

Any unknown canonical state is `NO-GO`.

### Observed blue snapshot, 2026-08-22

Read-only inventory found Nano on Ubuntu 18.04.5 ARM64 with Docker 20.10.2, 57 GiB root storage
(21 GiB free), 3.9 GiB RAM and exhausted 1.9 GiB swap. It runs the four application processes plus
PostgreSQL, Redis, RabbitMQ, MinIO, Caddy, Nginx, OTel, Prometheus, Loki, Grafana, Portainer,
Swagger and a separate CUP production API/proxy.

The active application release is `e308181da5222645d9a87d03642923c6841be8d1`, and its recorded
latest migration is `0059_game_conversations.sql`; `main@c2c3350027e9d00480315a0ea6d89084730b2562`
contains migrations through `0088_participation_command_foundation.sql`. This drift forbids treating
the move as a byte-for-byte container copy. Schema advancement, if required, remains a separate
migration gate.

State volume sizes at that snapshot were approximately: PostgreSQL 1.136 GB, RabbitMQ 125.6 MB,
Redis 36.63 MB, MinIO 17.59 MB, Prometheus 45.48 MB and Grafana 25.04 MB. Caddy data/config, Loki
and Portainer were smaller but are still explicit custody decisions. Re-measure immediately before
rehearsal and cutover.

The green inventory completed through the audited `phub-admin` identity using the Nano as a strict
SSH jump host. Direct Mac-to-green Tailscale TCP/22 remained unavailable even though Tailscale ICMP
worked; this is a local path limitation, not a green-host readiness claim. Keep strict host-key and
dedicated-key checks on every jump-host command, and do not make Nano retirement depend on that
temporary path: prove a direct audited administration route before cutover.

## Gate 1 — immutable amd64 publication

Merge the reviewed publication workflow only after its protected environment and immutable base
image contract are accepted. Under a separate registry-push approval, publish exactly five
`linux/amd64` images from one exact merged SHA. Require registry readback, a complete digest
manifest, SBOM and provenance. Publication is not deployment. The manifest must identify
`35c8312b79cccdd136f2bfd892efbea629b8b919`; another source requires a new reviewed workflow.

## Gate 2 — isolated green bootstrap

Provision Timeweb without public application traffic or provider writes:

1. verify supported amd64 Ubuntu, Docker Engine/Compose and sufficient disk/RAM;
2. create the external `phub-ingress`, `phub-data`, `phub-telemetry` and `phub-admin` networks; a
   host-local CUP bridge is not a cross-host transport;
3. pin exact infrastructure image digests;
4. create the exact separated runtime env files below through the approved secret channel and run
   `scripts/verify-timeweb-runtime-env.sh host /etc/phub` before rendering Compose;
5. configure Timeweb S3 as a private runtime bucket; keep backup identity/bucket separate;
6. start infrastructure with fresh disposable volumes;
7. validate Compose, healthchecks, loopback-only management ports, UFW and Tailscale SSH;
8. keep Caddy dark or on non-production names until restore acceptance passes.

Rollback: remove only the disposable green stack. Blue remains untouched.

### Green runtime identity and env contract

Install runtime env files as root-owned regular files, mode `0600`, without symlinks. The shared
`/etc/phub/staging.env` contains database, RabbitMQ and Redis runtime URLs plus non-secret runtime
configuration, but no S3 access keys. API receives the existing auth, override, games, Communities
and chat/push contours plus `/etc/phub/staging.api-s3.env`. Worker receives the shared contours plus
`/etc/phub/staging.worker-s3.env`. The two S3 files each contain exactly `S3_ACCESS_KEY` and
`S3_SECRET_KEY`, use different non-empty Timeweb identities and are limited to the exact runtime
bucket. The shared database URL uses role `phub_runtime`; the isolated migration URL uses distinct
role `phub_migrator`, and both target only database `phub` on the green `postgres` service.
Realtime receives only `/etc/phub/realtime.env` and no provider, auth-refresh, S3 or migration
credentials. Migrator receives only `/etc/phub/staging.migrator.env`, containing exactly one
`DATABASE_URL` for the dedicated migration role.

The base stack excludes Portainer and any Docker-socket mount. Administrative Docker access remains
root-equivalent and outside application containers. Redis mounts a root-owned mode-`0440` ACL file
whose dedicated numeric group is supplied through required `REDIS_RUNTIME_GID` and added only to
the Redis container. No host login belongs to that group. The default user can only answer `PING`,
while the application user uses a generated green-only
password, excludes admin/dangerous categories and enables only connection/read/write/transaction/
pubsub commands plus the Lua operations used by PadlHub. Never install the disabled repository
example as a working credential.

Install the reviewed bundle under `/opt/phub/releases/<exact-sha>/`, owned by root and not writable
by the deploy identity. Verify the bundle checksum manifest before atomically selecting it through a
root-owned `/opt/phub/current` symlink. Relative Compose mounts resolve only inside that immutable
release tree; `/etc/phub` and named volumes remain outside it. Bundle installation, symlink switch
and network creation are provisioning actions requiring their own approval.

### Deterministic operations bundle and root executor

After this draft is committed, never execute the working-tree builder as the custody source. In a
clean trusted clone, extract the builder blob with the system Git binary from the approved commit,
then execute that extracted blob into a new empty directory:

```sh
ops_sha=<40-character-ops-sha>
output_directory=<new-empty-output-directory>
builder_custody=$(mktemp -d /tmp/phub-timeweb-builder.XXXXXX)
GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/git show "$ops_sha:scripts/build-timeweb-install-bundle.sh" \
  > "$builder_custody/build-timeweb-install-bundle.sh"
chmod 0500 "$builder_custody/build-timeweb-install-bundle.sh"
(cd "$(/usr/bin/git rev-parse --show-toplevel)" && \
  "$builder_custody/build-timeweb-install-bundle.sh" "$ops_sha" "$output_directory")
```

The builder first compares its own bytes against
`<ops-sha>:scripts/build-timeweb-install-bundle.sh`, disables Git replace objects and ignores
caller-supplied Git repository/config overrides. It reads `deploy/timeweb/install-manifest.txt` from
the named ops commit and reads the distinct `PHUB_APPLICATION_SHA` from that same commit. Operations
files are archived from the ops SHA, while `contracts/openapi` is archived separately from the exact
application SHA `35c8312b79cccdd136f2bfd892efbea629b8b919`; contracts from ops HEAD must never be
mixed with older runtime images. It emits five immutable artifacts: the operations archive, exact
application-contracts archive, per-file mode+SHA-256+source-SHA manifest, non-authorizing receipt and
artifact checksum manifest. Dirty working-tree bytes cannot enter either archive. An
independent custody reviewer, using a different clean clone, requires `git fsck --full`, compares the
receipt `tree_sha` to `/usr/bin/git rev-parse "$ops_sha^{tree}"`, compares `application_tree_sha`
and `contracts_tree_sha` to the separately approved application commit, reconstructs every
`mode|sha256|source_sha|path` record from the applicable `/usr/bin/git ls-tree` plus
`/usr/bin/git show`, and requires a byte-identical sorted manifest before approving its SHA-256 in
the ledger. The reviewer also records both archive SHA-256 values and the artifact-manifest SHA-256.
No hash printed only by the builder is an approval anchor. Every receipt states `installation=false`,
`authorizes_deploy=false` and `authorizes_database_mutation=false`.

Under a separate code-install/provisioning approval, place the five files in root-owned mode-`0440`
custody at `/var/lib/phub-preflight/timeweb-bundles/<ops-sha>/` with directory mode `0700`. Verify the
artifact manifest, extract only `deploy/timeweb/root-executor.sh`, compare it against the per-file
checksum and install it as root-owned mode `0755` at
`/usr/local/sbin/phub-timeweb-root-executor`. Then the bounded installation command is:

```sh
sudo -n /usr/local/sbin/phub-timeweb-root-executor \
  install-bundle <ops-sha> <ops-archive-sha256> <application-contracts-archive-sha256> \
  <artifacts-manifest-sha256>
```

It rejects links, non-root custody, unexpected archive types/paths, checksum drift and existing or
partial releases; extracts into `/opt/phub/releases/.incoming-<ops-sha>`; verifies every file; then
atomically renames the complete tree and switches `/opt/phub/current`. It never starts containers.
An interrupted `.incoming-*` directory is a reconciliation stop and is never automatically removed.

All Compose rendering and runtime actions execute through this root-owned wrapper, so the deploy
identity never reads root-mode env files and does not need Docker-group membership. After wrapper
installation and a second administrative access path are proven, replacing the temporary
`phub-admin NOPASSWD: ALL` grant with this single bounded executable is a separate access-change
gate. The supported operations are exactly `install-bundle`, `preflight`, `status`, `probe`,
`rollback-ops`, `start-infrastructure`, `start-application-dark`, `start-ingress` and
`rollback-green`. There is no migrator operation. Every mutating operation additionally requires a
root-owned mode-`0400` single-use permit under
`/var/lib/phub-preflight/timeweb-authorizations/<operation>.<ops-sha>.permit`. A permit contains
exactly the `PHUB_TIMEWEB_ROOT_AUTHORIZATION_V1` header plus `operation`, `ops_sha`, a ten-digit
`expires_epoch` no more than one hour ahead, and a unique 32-hex `nonce`. It is created only through
the independent root/console approval path, atomically moved to root-only consumed custody before
the mutation, and recorded in `/var/log/phub-timeweb-root-executor.audit`. The executor holds a
global nonblocking root lock, so install/start/rollback operations cannot interleave. Installation
records the prior immutable release
as `/opt/phub/previous`; if candidate rendering fails before any container action,
`rollback-ops` atomically selects that verified tree again without touching containers.

Before any start, require:

```sh
sudo -n /usr/local/sbin/phub-timeweb-root-executor preflight
```

The publication/reconciliation workflow must supply a machine-readable release manifest before any
image pull or start. Validate the downloaded artifact locally before it is admitted to a root-owned
release directory:

```sh
node scripts/verify-timeweb-release-manifest.js /path/to/release-manifest.json
```

The validator is deliberately pinned to the selected application SHA and checks the schemaVersion,
repository, linux/amd64 platform, exact five-component set, component repository names, immutable
`sha256` digests, source revision, and the required provenance/SBOM/reconciliation assertions. A
boolean assertion in the manifest is not independent attestation evidence: the publication gate
must also retain and verify the corresponding provenance and SBOM artifacts. Until that workflow
publishes a successful machine manifest, image pull, migration, application start and ingress remain
blocked. Do not synthesize the manifest from partial job receipts or copy digests from prose.

This rechecks the installed release's file manifest, root metadata, isolated env contract and all
three rendered Compose documents without printing secret values. It also reuses the established
API/realtime secret-isolation verifier and rejects non-root or permissive metadata on every present
auth, override, games, Communities and chat/push contour.

### Timeweb S3 compatibility gate

Use `https://s3.twcstorage.ru`, region `ru-1`, path-style requests and
`S3_AUTO_CREATE_BUCKET=false`. Enable versioning before application access. Provisioning uses a
separate management identity; the application identity receives only the required object read/write
permissions and cannot change bucket policy, CORS, lifecycle or versioning.

Timeweb's presigned-URL documentation warns that signing `Content-Type` can cause upload errors,
while the PadlHub media contract signs `Content-Type`, checksum, metadata, cache control and
`If-None-Match`, and requires exact object versions. Before any data copy or application deploy, run
the complete storage verification against a disposable Timeweb test bucket and require: signed PUT,
replay `412`, metadata/checksum equality, version ID, exact-version worker read, idempotent variant
write, signed GET and cleanup. Do not weaken the PadlHub integrity/idempotency contract to make a
provider pass; an unsupported header or version behavior is `NO-GO` pending an adapter decision.

References: [Timeweb JavaScript SDK](https://timeweb.cloud/docs/s3-storage/sdk/javascript),
[versioning](https://timeweb.cloud/docs/s3-storage/supported-features/s3-object-versioning), and
[presigned URLs](https://timeweb.cloud/docs/s3-storage/supported-features/presigned-url).

### External prerequisite — CUP production relocation

This staging runbook must not stop, copy, reconfigure, rotate or revoke `cup-production-api`,
`cup-production-proxy`, `cup-production_default` or `phab-showcase_default`. Full Nano retirement
requires a separate production-authorized CUP migration runbook covering its own source of truth,
backup, deploy, cutover, rollback, secrets and monitoring. Gate 5 accepts only that runbook's signed
completion receipt plus authenticated CUP and worker-integration evidence. A Nano-local Docker
bridge is never treated as a cross-host transport.

## Gate 3 — restore rehearsal

Rehearse twice with a verified Nano snapshot in an isolated green environment:

1. create a PostgreSQL custom-format archive, verify `pg_restore --list`, SHA-256 and off-host
   custody;
2. export a separately encrypted roles/default-privileges manifest without reusing password hashes;
   reissue green credentials and verify owners, grants and default privileges after restore;
3. restore into a clean PostgreSQL 16 target;
4. verify extensions, `schema_migrations`, tenant/RLS constraints and bounded aggregate counts;
5. under separate schema authority, run the exact `35c8312` digest-pinned migrator twice and require
   the second run to apply nothing and the ledger to end at `0088`;
6. build an exact MinIO object/version manifest containing key, version, size, ETag/checksum and
   metadata; pre-copy to Timeweb S3 without deletion, reproduce versioning/CORS/lifecycle/private
   policy, and reconcile referenced, orphaned and tombstoned objects explicitly;
7. export/import RabbitMQ definitions only; prove either queue drain or full replay from durable
   PostgreSQL outbox/inbox before accepting an empty broker;
8. start Redis fresh only after proving no canonical revocation/session state is lost;
9. run private authenticated read, tenant isolation, media, worker and realtime recovery probes.

Discard the rehearsal environment after capturing evidence. Archive readability alone is not a
restore rehearsal.

All PostgreSQL/media backups are encrypted before leaving the source using a separate backup key or
KMS identity. Transfers use TLS, temporary plaintext files are mode `0600`, credentials never enter
arguments/logs/artifacts, and the private backup bucket has access logging and a restore-only
principal. A rehearsal restores from the encrypted off-host artifact. Plaintext removal and later
retention cleanup each require enumerated evidence and the applicable approval.

## Gates 4–5 — pre-copy and cutover readiness

Perform a non-deleting initial S3 copy, then require:

- exact green app and infrastructure digests;
- two successful restore rehearsals;
- verified off-host backup and restore owner;
- maintenance, freeze, rollback and forward-recovery commands reviewed;
- operator, window, RPO/RTO and decision timeout recorded;
- DNS TTL elapsed or explicitly accounted for;
- Timeweb TLS ready and Viva/provider egress contract accepted;
- the separate CUP production migration completion receipt proves CUP no longer depends on Nano.

Run the aggregate green probe after each permitted start and at least once per minute during private
observation and soak:

```sh
sudo -n /usr/local/sbin/phub-timeweb-root-executor probe infrastructure
sudo -n /usr/local/sbin/phub-timeweb-root-executor probe application-dark
sudo -n /usr/local/sbin/phub-timeweb-root-executor probe ingress
```

The probe emits only aggregate values and fails closed on disk usage `>=70%`, free space below
20 GiB, memory usage `>=80%`, any restart/OOM/stopped expected container, PostgreSQL connections
`>=70%` of `max_connections`, Rabbit ready/unacked backlog, OTel/Prometheus/Grafana/Swagger
readiness, a down OTel scrape target, recent Nginx 5xx, API/realtime readiness or TLS/upstream
failure. Prometheus retains application metrics; Docker's bounded local logging driver retains
sanitized service logs. Timeweb intentionally omits Loki until a reviewed least-privilege log
shipping design exists; an unconnected Loki container is not observability.

## Gate 6 — blue freeze and final capture

This is a live mutation gate. Under explicit approval:

1. block concurrent deploy/migrate and record blue release/digest/config hashes;
2. disable staging CI deploy/schedule jobs and provider callback command paths; enable maintenance on
   every staging command path and reject new WebSocket sessions; do not mutate CUP production under
   this approval;
3. drain bounded in-flight HTTP; stop schedulers/producers;
4. drain RabbitMQ/DLQ to the accepted target or record backlog with proven outbox/inbox replay;
5. stop worker, API, realtime and migrator; fence every inventoried database role and media writer at
   the database/storage boundary, terminate pre-fence sessions, then require a recorded zero-writer
   `pg_stat_activity` and object-store access-log interval; the backup identity remains read-only;
6. take the final PostgreSQL archive and off-host hash receipt;
7. run the final non-deleting S3 delta and verify every database media key exists;
8. capture Rabbit definitions and queue/unacked/DLQ/outbox/inbox counts.

Before a green write, rollback may restart the exact frozen blue release and remove maintenance.

### Executable pre-write rollback

Rollback before the first accepted green write is project-scoped and volume-preserving:

1. keep maintenance enabled and record `status` plus the latest successful green probe;
2. under the ingress/DNS authority, route the public staging name back to the already frozen Nano;
3. execute `sudo -n /usr/local/sbin/phub-timeweb-root-executor rollback-green` on Timeweb;
4. require its receipt to contain `operation=rollback-green` and `volumes_preserved=true`;
5. execute `status` again and retain every emitted `TIMEWEB_VOLUME` record;
6. restart only Nano's exact `e308181d`/`0059` blue Compose project using its reviewed release
   procedure, then repeat authenticated read/media/realtime probes before removing maintenance.

The root executor uses `docker compose stop`, never `down`, `volume rm` or prune. It stops Caddy,
Migrator if unexpectedly present, Worker if present, API, Realtime, Web and infrastructure while
preserving all named green volumes. If any stop is partial or returns non-zero, do not rerun with a
broader Docker command: record `status`, reconcile the exact remaining project containers, and
require a new rollback decision.
DNS/provider routing and blue restart remain separate operator-controlled steps because a green-host
script must not mutate the rollback target. If any green write has already been accepted, this
route-back procedure is forbidden: recover forward on green or restore from off-host custody under
a new incident decision.

## Gates 7–9 — green restore, ingress and first write

Start in this order: PostgreSQL, S3 checks, RabbitMQ definitions with worker stopped, fresh Redis,
Web/API and Realtime behind private ingress. Worker remains outside the default Compose start and is
enabled through its `worker` profile only after the signed CUP completion receipt and exact
`phab-showcase_default` network preflight. Then validate:

- exact web manifest release and JSON API boundaries rather than SPA fallback;
- schema ledger, RLS and cross-tenant deny probes;
- authenticated read/refresh/cookie/origin behavior;
- API-issued signed media URLs resolve directly to the exact Timeweb S3 bucket, while the legacy
  `/phub-media/` proxy returns `410` and direct unsigned S3 access is denied;
- worker duplicate/restart recovery and Rabbit/outbox convergence;
- realtime reconnect plus exact gap recovery;
- CUP login/read/admin routes and Viva callback path/query/cookie;
- provider reads from the new egress IP;
- CPU, RAM, swap, disk, DB pool, queues/DLQ, outbox age, S3 errors, 5xx and TLS alerts.

Cutover aborts on any reconciliation mismatch, cross-tenant success, duplicate effect, missing media
object, DLQ item, S3/TLS error or HTTP 5xx during the acceptance probes. During the 30-minute private
green observation, require CPU below 70%, memory below 80%, disk below 70% with at least 20 GiB free,
database pool below 70%, zero ready/unacked/DLQ backlog after convergence, outbox oldest age below
60 seconds and API p95 below 500 ms and no worse than 25% over the recorded blue baseline. The
release operator owns STOP; proceeding after a threshold breach requires a new reviewed decision.

The bounded `probe` operation covers host CPU/RAM/swap/disk, Docker health/restarts/OOM, PostgreSQL
pool pressure, authenticated Redis ACL access, Rabbit backlog, local readiness, recent Nginx 5xx and
TLS termination. Its receipt always states `authorizes_cutover=false`. API p95, outbox age, S3 error
rate, DLQ semantics and TLS alert history remain separate required Prometheus/application evidence;
until named queries and a complete 30-minute evidence record exist, this runbook is fail-closed for
cutover even when every bounded probe passes.

Switch ingress while maintenance remains enabled. A separate approval permits one synthetic,
idempotent green command. Require one audit/outbox/worker effect and idempotent replay before public
writes are enabled. That first accepted green write is the route-back point of no return.

## Gates 10–13 — soak and Nano retirement

Soak Timeweb for 48–72 hours. Then require 72 hours with:

- no staging traffic between Timeweb and Nano;
- no DNS/NAT/Caddy, GitHub, environment, monitoring or backup reference to Nano;
- successful scheduled deploy/readiness and authenticated probes while Nano staging is stopped;
- restore from off-host custody without Nano.

With separate stop/revoke approval, disable Nano staging containers, remove its CI/DNS/Tailscale
bindings and revoke staging credentials. Keep final Nano volumes and backups for 7–30 days. Delete
containers, volumes, backups and keys only from an enumerated evidence list under a final destructive
approval.

## Approval ledger

Record each gate with exact SHA/digests, operator, timestamp, evidence and rollback decision. Separate
approvals are required for: publication workflow merge; registry push; VPS provisioning/firewall;
secret creation/transfer; live backup/S3 copy; green deploy; Nano freeze/stop; PostgreSQL restore or
migration; Rabbit/Redis mutation; DNS/TLS/GitHub environment changes; synthetic authenticated write;
public writes; Nano credential revocation; and destructive cleanup. The CUP production migration has
its own independent authority and ledger; its completion receipt is an input, never an implied grant.
