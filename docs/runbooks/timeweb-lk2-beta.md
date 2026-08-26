# Timeweb LK2 beta deployment

This runbook publishes one isolated HTTPS beta contour from the exact current `main`. It does not
authorize merge, DNS/provider mutation, provider writes, payment flows, mass backfill, destructive
database work, or retirement of another contour. Stop on identity drift or any missing gate.

## 1. Freeze repository and release identity

Use a clean checkout. Preserve every dirty user checkout.

```sh
git fetch origin --prune
git rev-parse origin/main
git rev-parse 'origin/main^{tree}'
git ls-remote origin refs/heads/main
git log --first-parent --oneline -5 origin/main
```

Record `SOURCE_SHA` and `SOURCE_TREE`. The local remote-tracking SHA, `ls-remote`, reviewed source,
workflow ref and later manifest must all match. Inventory open PRs and merge ownership. Any drift is
`STOP`. Dispatch `.github/workflows/publish-timeweb-amd64-images.yaml` from `SOURCE_SHA` exactly as
documented in `timeweb-amd64-image-publication.md`. Accept only a successful first attempt whose
canonical artifact contains exactly `release-manifest.json` and `release-manifest.sha256`.

Download the artifact into a new local directory and render a no-clobber, mode-0600 release file:

```sh
node scripts/verify-timeweb-release-manifest.js ARTIFACT/release-manifest.json \
  --expected-publication-workflow-sha "$SOURCE_SHA" \
  --expected-publication-run-id "$PUBLICATION_RUN_ID" \
  --expected-publication-run-attempt 1
node scripts/render-timeweb-beta-release-env.js \
  --manifest ARTIFACT/release-manifest.json \
  --output release.env \
  --expected-workflow-sha "$SOURCE_SHA" \
  --expected-run-id "$PUBLICATION_RUN_ID" \
  --expected-run-attempt 1
```

Never substitute tags for the emitted index digests. Retain the canonical pair, checksum, workflow
URL, run ID/attempt and exact reviewed commit as release evidence.

Temporal source freshness is a repeated gate, not a one-time preflight. From the same clean operator
checkout, run this immediately before the first host mutation and again immediately before service
activation:

```sh
git fetch origin --prune
test "$(git rev-parse origin/main)" = "$SOURCE_SHA"
test "$(git rev-parse 'origin/main^{tree}')" = "$SOURCE_TREE"
test "$(git ls-remote origin refs/heads/main | awk '{print $1}')" = "$SOURCE_SHA"
```

Any drift is `STOP`. Do not automatically republish or deploy the now-stale manifest; restart the
review/publication decision from the new exact main.

## 2. Prove the Timeweb target before access

In the Timeweb console, record the server ID, name, project/account, public IP, status, region,
resources and console/SSH access path. Match the public IP and the pinned SSH host key through two
independent sources. A timed-out SSH banner is not host proof. Do not trust an IP copied from an old
run. Stop if the target identity is ambiguous.

On the proved host, make read-only checks before installing or changing anything:

```sh
docker_local() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    docker --context default "$@"
}
test "$(docker_local context show)" = default
test "$(docker_local context inspect default --format '{{(index .Endpoints "docker").Host}}')" = \
  unix:///var/run/docker.sock
uname -m
cat /etc/os-release
docker_local version
docker_local compose version
df -h
free -h
ss -lntup
docker_local ps --no-trunc
docker_local network ls
```

Require `x86_64`, supported Docker/Compose, enough disk/RAM, free public ports 80/443, no conflicting
containers, and a firewall that permits only the intended management path plus 80/443. Do not stop
or reconfigure unrelated workloads. Confirm that `172.30.26.0/24` does not overlap an existing
route or Docker network before creating the external `phub-timeweb-beta` network.

## 3. Prove data, broker and OAuth compatibility

The beta must use one coherent PostgreSQL/Redis/RabbitMQ contour. Perform read-only target
fingerprinting and compare database identity, Redis database, RabbitMQ vhost/exchange/queue topology
and TLS mode. Do not attach a worker if another contour can process the same queues without the
documented leased-outbox and consumer horizontal-safety guarantees.

Classify schema migration as `N/A` only when the database ledger contains all repository migrations
through `0088_participation_command_foundation.sql`, in order, with the exact repository checksums,
no gaps and no unknown entries, and the role/ACL/RLS v3 checks for migrations 0084-0088 pass. The
repository migrator has no allowlist or dry-run mode and applies every pending migration. In
particular, pending `0084` performs tenant-wide seed/backfill work. Therefore any pending, changed,
unknown or unverifiable migration is `STOP`; do not run the migrator in this rollout. Pulling and
retaining the migrator image is still required as one of the five release components.

Confirm read-only that the Viva OAuth client already permits exactly:

```text
https://<beta-host>/user/api/v1/<tenant-key>/auth/viva/callback
```

If it is not already allowed, stop: this rollout does not authorize changing provider
configuration. Confirm the beta hostname resolves to the proved server before enabling TLS.

## 4. Provision secrets without disclosure

Obtain the four source files from the approved secrets system of record. If the source of any
dependency or provider credential is unknown, unauthenticated or cannot be audited without reading
the value, classify provisioning as `STOP`. Create no value on the command line and do not use
`set -x`. On the operator workstation, place exactly four files in a temporary `0700` directory,
each with mode `0600`. The local directory contains exactly:

```text
api.env
worker.env
realtime.env
migrator.env
```

The provisioner installs them at the corresponding paths under `/etc/phub/timeweb-beta`.

Do not copy a repository `.env`, log values, paste secrets into shell history, or mount the migrator
file into a long-running service. Use distinct least-privilege database identities where supported;
the application role must not own schema objects. API and worker receive only their required
credentials. Worker receives no signing secret. API and realtime share only the dedicated
`JWT_REALTIME_SECRET` so the API can mint one-time realtime tickets; realtime never receives API
access/refresh signing keys or provider credentials. Use unique `OTEL_SERVICE_INSTANCE_ID` values.
Set the same explicit `JWT_REALTIME_AUDIENCE` in API and realtime.
API must set `VIVA_MODE=production`; `VIVA_MODE=mock`, `AUTH_DEV_PHONE_E164` and
`AUTH_DEV_OTP_CODE` are forbidden because the mock identity provider accepts known development
credentials.

Transport only this exact file set through the already-attested SSH host key. The archive contents
travel only on authenticated SSH stdin, never in arguments or stdout. The remote temporary
directory is memory-backed `/run`, is removed on exit, and the reviewed provisioner validates all
values before replacing the live directory. The provisioner writes a new root-only directory,
fsyncs each file, rejects symlinks/hardlinks/extras, preserves the prior directory under a
no-clobber release ID, and emits metadata only:

Immediately before this pipeline, pass the repeated temporal source-freshness gate in section 1.

```sh
# Operator workstation; LOCAL_SECRET_DIR must be a freshly exported 0700 directory.
test "$(stat -f '%Lp' "$LOCAL_SECRET_DIR")" = 700
test "$(find "$LOCAL_SECRET_DIR" -mindepth 1 -maxdepth 1 -type f -perm 600 | wc -l | tr -d ' ')" = 4
tar -C "$LOCAL_SECRET_DIR" -cf - api.env worker.env realtime.env migrator.env | \
  ssh -T -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes root@103.88.243.171 \
  "umask 077; incoming=\$(mktemp -d /run/phub-timeweb-beta-secrets.XXXXXX); \
trap 'rm -rf -- \"\$incoming\"' EXIT; \
tar --no-same-owner --no-same-permissions -xf - -C \"\$incoming\"; \
node '$RELEASE_DIR/scripts/provision-timeweb-beta-runtime-secrets.js' \
--source-dir \"\$incoming\" --host '$LK2_BETA_HOST' --tenant-key '$TENANT_KEY' \
--release-id '$RELEASE_ID'"
```

Remove the local temporary export through the approved secrets-tool cleanup mechanism immediately
after the metadata-only verifier passes. Do not retain it in the repository or release directory.
Retain root-only server backups only for the documented rollback window; remove them later only
through the approved secret-destruction procedure, never as part of this rollout.

Both API and worker must be `APP_ENV=staging`, share the proved dependency contour and set the
following matrix. API uses `GAMES_READ_ENABLED=true`; worker uses `GAMES_READ_ENABLED=false`:

```text
GAMES_COMMANDS_ENABLED=false
LEGACY_GAME_COMMAND_BRIDGE_ENABLED=false
PARTICIPATION_COMMANDS_ENABLED=false
GAMES_RESULTS_WRITE_MODE=disabled
GIFT_CERTIFICATE_PAYMENT_MODE=disabled
GIFT_CERTIFICATE_ISSUANCE_ENABLED=false
SUBSCRIPTION_RUNTIME_WARN_MODE=OFF
BOOKING_REMINDER_SCHEDULER_ENABLED=false
PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED=false
ACTIVITY_HISTORY_SYNC_ENABLED=false
ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED=false
PROFILE_PHOTO_MAINTENANCE_ENABLED=false
```

Worker additionally requires `OUTBOX_PUBLISH_MODE=leased` and
`WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true`. API requires secure cookies, exact
single-origin CORS, trusted proxy `172.30.26.10/32`, disabled CUP development auth, and the exact
OAuth callback/success URLs. Validate file metadata and values on the host without printing them:

```sh
node scripts/verify-timeweb-beta-runtime-env.js \
  --host "$LK2_BETA_HOST" --tenant-key "$TENANT_KEY" \
  --api /etc/phub/timeweb-beta/api.env \
  --worker /etc/phub/timeweb-beta/worker.env \
  --realtime /etc/phub/timeweb-beta/realtime.env \
  --migrator /etc/phub/timeweb-beta/migrator.env
```

If post-install verification fails and a prior directory was backed up, keep services stopped,
move the rejected directory to a new root-only quarantine path, rename
`/etc/phub/timeweb-beta-backups/$RELEASE_ID/previous` back to
`/etc/phub/timeweb-beta`, and re-run the
metadata-only verifier. Never overwrite either directory. On a first installation, quarantine the
rejected directory and stop; there is no secret preimage to restore.

## 5. Backup and prepare rollback

Before activation, create a timestamped root-only release directory. Preserve the previous
`release.env`, Compose files, Caddyfile, Caddy data/config snapshot, container inspect output and
health evidence. Record the exact previous image digests and keep those images locally. Validate
that the rollback files parse and that enough disk remains for both releases.

Use an explicit release ID and never overwrite a prior point:

```sh
install -d -m 0700 /opt/phub/timeweb-beta/releases /opt/phub/timeweb-beta/rollback
RELEASE_ID="$SOURCE_SHA-$PUBLICATION_RUN_ID-1"
RELEASE_DIR="/opt/phub/timeweb-beta/releases/$RELEASE_ID"
ROLLBACK_DIR="/opt/phub/timeweb-beta/rollback/$RELEASE_ID"
install -d -m 0700 "$RELEASE_DIR" "$ROLLBACK_DIR"
docker_local ps --no-trunc > "$ROLLBACK_DIR/docker-ps.before.txt"
docker_local volume inspect phub-timeweb-beta-caddy-data phub-timeweb-beta-caddy-config \
  > "$ROLLBACK_DIR/caddy-volumes.before.json" || true
```

If a prior beta contour exists, copy its complete root-only release directory into
`$ROLLBACK_DIR/previous-release` without following symlinks and record its resolved path. After the
pinned Caddy image is pulled, snapshot each existing Caddy volume read-only:

```sh
docker_local run --rm --network none \
  --volume phub-timeweb-beta-caddy-data:/source:ro \
  --volume "$ROLLBACK_DIR:/backup" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  sh -c 'cd /source && tar -cf /backup/caddy-data.tar .'
docker_local run --rm --network none \
  --volume phub-timeweb-beta-caddy-config:/source:ro \
  --volume "$ROLLBACK_DIR:/backup" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  sh -c 'cd /source && tar -cf /backup/caddy-config.tar .'
sha256sum "$ROLLBACK_DIR"/caddy-*.tar > "$ROLLBACK_DIR/caddy-volumes.sha256"
```

For a first installation, prove and record that no prior beta containers or named volumes exist;
that absence plus the preflight outputs is the rollback preimage. Do not create empty placeholder
archives.

No database mutation is allowed by this initial rollout, so a database restore must not be its
normal rollback mechanism. If an independently approved migration ever becomes necessary, take and
verify a database backup first and use a separate expand/migrate/contract plan. Prefer forward
recovery once application writes have occurred.

## 6. Stage five application images

Copy only the reviewed Compose/Caddy files, verifier, canonical artifact and non-secret
`release.env` to the new release directory. Create the external network only after the overlap
check. Authenticate GHCR through a root-only Docker credential store, then:

```sh
umask 077
compose_beta() {
  docker_local compose --project-name phub-timeweb-beta \
    --env-file "$RELEASE_DIR/release.env" \
    -f "$RELEASE_DIR/deploy/timeweb/compose.beta.yaml" "$@"
}
compose_ingress() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    LK2_BETA_HOST="$LK2_BETA_HOST" \
    CADDY_DATA_VOLUME=phub-timeweb-beta-caddy-data \
    CADDY_CONFIG_VOLUME=phub-timeweb-beta-caddy-config \
    docker --context default compose --project-name phub-timeweb-beta-ingress \
    -f "$RELEASE_DIR/deploy/timeweb/compose.ingress.yaml" "$@"
}
compose_beta --profile background --profile migration config --images \
  > "$ROLLBACK_DIR/compose-images.actual.txt"
node "$RELEASE_DIR/scripts/verify-timeweb-beta-compose-images.js" \
  --release-env "$RELEASE_DIR/release.env" \
  --actual-images "$ROLLBACK_DIR/compose-images.actual.txt"
compose_beta --profile background --profile migration pull
compose_ingress pull
while IFS= read -r image; do
  docker_local image inspect "$image"
done < "$ROLLBACK_DIR/compose-images.actual.txt"
```

Verify every local image is `linux/amd64`, carries the exact source revision, and resolves to the
manifest digest. Do not run the migrator unless a separate migration gate has passed.

After the pinned Caddy image is present locally, validate and adapt the exact candidate without
network access before activation. Both commands must succeed and the adapted JSON must be retained
with the release evidence; any warning about an unrecognized directive or empty host is `STOP`:

```sh
docker_local run --rm --network none \
  --env "LK2_BETA_HOST=$LK2_BETA_HOST" \
  --volume "$RELEASE_DIR/deploy/timeweb/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker_local run --rm --network none \
  --env "LK2_BETA_HOST=$LK2_BETA_HOST" \
  --volume "$RELEASE_DIR/deploy/timeweb/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  caddy adapt --pretty --config /etc/caddy/Caddyfile --adapter caddyfile \
  > "$ROLLBACK_DIR/caddy-adapted.json"
```

## 7. Activate in dependency order

Start API and realtime first, then web, by naming those three services explicitly. Require
health/readiness and stable logs. The worker is under the `background` profile and must remain
stopped for the initial beta: even with command flags disabled it can publish an existing outbox
backlog and execute scheduled lifecycle writes. Its image and validated env remain staged as one of
the five release components. Starting it requires a separate background-worker gate proving an
empty/owned backlog, queue topology and exact allowed write set. Finally start Caddy from
`compose.ingress.yaml`; it is the only service with host ports. Require a valid public certificate,
correct chain/hostname, HTTP-to-HTTPS behavior, HSTS, and no exposure of internal API or container
ports.

```sh
# First repeat the section 1 source-freshness gate from the clean operator checkout.
compose_beta --profile background --profile migration config --images \
  > "$ROLLBACK_DIR/compose-images.pre-up.actual.txt"
node "$RELEASE_DIR/scripts/verify-timeweb-beta-compose-images.js" \
  --release-env "$RELEASE_DIR/release.env" \
  --actual-images "$ROLLBACK_DIR/compose-images.pre-up.actual.txt"
compose_beta up -d api realtime web
compose_beta ps
compose_ingress up -d caddy
```

Check container restart counts, resource pressure, correlation IDs, redacted logs and release SHA.
The active runtime SHA and all five local digests must match the canonical manifest.

## 8. Browser and application smoke

Use a normal browser against `https://<beta-host>` and retain screenshots/network evidence:

1. Load the LK2 shell with no mixed content or console errors.
2. Complete the existing Viva OAuth flow and confirm secure cookies and the intended tenant.
3. Open profile, catalog, one item detail and realtime connection; confirm API responses and UI.
4. Record the current `recommendationDisplay` booking preference.
5. Through the UI, toggle only `CARDS` to `ROWS` or `ROWS` to `CARDS`. This uses the local-only,
   audited `PUT /profile/booking-preferences` path and must not call Viva or payment endpoints.
6. Refresh independently and confirm the new value persisted. Leave that single accepted value in
   place; restoring it would be a second live write and is outside this rollout. Never create a
   booking, payment, subscription, join, gift-certificate sale or provider command as smoke
   evidence.

Correlate the browser request with API audit/outbox evidence and verify no disabled consumer or
provider write ran. A frontend success without persisted read-back is not PASS.

## 9. Rollback

Before application writes, rollback by stopping ingress and the new application services, restoring
the previous release files/digests, recreating the prior containers and verifying their health. Do
not delete the failed release or evidence. After any persisted application write, preserve data and
prefer a forward application rollback to the previous digest; never restore a database snapshot
over newer accepted writes without a separately approved recovery decision.

For an existing prior contour, restore Caddy state into new volumes rather than clearing the failed
volumes. Verify the retained checksums, then:

```sh
sha256sum --check "$ROLLBACK_DIR/caddy-volumes.sha256"
ROLLBACK_DATA_VOLUME="phub-timeweb-beta-caddy-data-rollback-$RELEASE_ID"
ROLLBACK_CONFIG_VOLUME="phub-timeweb-beta-caddy-config-rollback-$RELEASE_ID"
docker_local volume create "$ROLLBACK_DATA_VOLUME"
docker_local volume create "$ROLLBACK_CONFIG_VOLUME"
docker_local run --rm --network none \
  --volume "$ROLLBACK_DATA_VOLUME:/restore" \
  --volume "$ROLLBACK_DIR:/backup:ro" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  sh -c 'cd /restore && tar -xf /backup/caddy-data.tar'
docker_local run --rm --network none \
  --volume "$ROLLBACK_CONFIG_VOLUME:/restore" \
  --volume "$ROLLBACK_DIR:/backup:ro" \
  caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  sh -c 'cd /restore && tar -xf /backup/caddy-config.tar'
cd "$ROLLBACK_DIR/previous-release"
docker_local compose --project-name phub-timeweb-beta \
  --env-file release.env -f deploy/timeweb/compose.beta.yaml config --quiet
docker_local compose --project-name phub-timeweb-beta \
  --env-file release.env -f deploy/timeweb/compose.beta.yaml up -d api realtime web
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  LK2_BETA_HOST="$LK2_BETA_HOST" \
  CADDY_DATA_VOLUME="$ROLLBACK_DATA_VOLUME" \
  CADDY_CONFIG_VOLUME="$ROLLBACK_CONFIG_VOLUME" \
  docker --context default compose --project-name phub-timeweb-beta-ingress \
  -f deploy/timeweb/compose.ingress.yaml config --quiet
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  LK2_BETA_HOST="$LK2_BETA_HOST" \
  CADDY_DATA_VOLUME="$ROLLBACK_DATA_VOLUME" \
  CADDY_CONFIG_VOLUME="$ROLLBACK_CONFIG_VOLUME" \
  docker --context default compose --project-name phub-timeweb-beta-ingress \
  -f deploy/timeweb/compose.ingress.yaml up -d caddy
```

For a first installation with no prior contour, rollback uses the same scrubbed-environment project
names to run `compose_ingress down` and `compose_beta down` without `--volumes`; retain the stopped
images, named volumes, release files and logs for investigation. Re-run the host preflight to prove
ports 80/443 returned to their exact preimage state.

Stop immediately on wrong-host evidence, source/digest drift, invalid TLS, migration uncertainty,
unproved broker safety, secret leakage, provider mutation, repeated restarts, unhealthy dependency,
or unexpected write/audit activity.

## 10. PASS evidence

PASS requires all of: fresh exact-main identity; successful five-image same-run publication and
canonical checksum; proved Timeweb host; AMD64 and capacity evidence; schema ledger/ACL compatibility
with migration `N/A`; coherent dependency and safe worker topology; secure least-privilege env;
digest-pinned runtime; valid HTTPS; active SHA/health/restart/log evidence; browser auth, catalog and
details; one safe preference write persisted after refresh; and a tested, retained rollback point.
Anything less is `NO-GO` or `STOP`, never a partial deployment PASS.
