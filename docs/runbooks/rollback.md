# Runbook: application rollback

1. Declare the incident and stop concurrent deployments.
2. Record release, environment, tenant impact and correlation IDs.
3. Select the last known-good **digest**, never a mutable tag.
4. Confirm the expanded database schema remains backward-compatible.
5. Remove app node A from the load balancer, deploy the previous digest, wait for readiness and run smoke tests.
6. Return A to traffic and repeat for node B.
7. Roll workers back only after checking event compatibility and queue lag.
8. Mark the rollback in observability, verify error/business-invariant recovery and close the alert only after a soak period.

Do not reverse a database migration as the first response. Escalate if the old binary is incompatible with current data.

## Nano staging primitive

Nano staging uses `deploy/jetson/backup-application.sh` and
`deploy/jetson/rollback-application.sh`. A confirmed manual deployment snapshots the active release
before overwriting any application or ingress definition. It accepts one explicit saved release
directory under `/opt/phub/backups/releases` and the exact confirmation token. The directory must contain the
previous `compose.yaml`, digest-pinned `release.env`, `nginx/default.conf`, `staging.auth.env`,
`tls-ingress/Caddyfile`, prior `staging.override.env`, `staging.communities.env` and
`staging.games.env` state (or their empty `.absent` markers), `process-state.env`, a
`worker-capabilities.env` attestation and a `backup.complete` marker written last with the previous
release SHA.

```sh
PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases \
  sh /opt/phub/rollback-application.sh \
  /opt/phub/backups/releases/pre-<candidate-sha>-<workflow-run>-<attempt> \
  --confirm=ROLLBACK_STAGING_RELEASE
```

The script validates all five application image digests and the saved Compose image set before
changing on-host files. It requires the previous web, API, worker and realtime images to already be
present locally, never uses registry credentials or pulls images, preserves the
displaced current files in a mode-`0700` `rollback-recovery-*` directory, restores saved files, and
starts no migration job. It validates restored ingress definitions when present and reports success
only after API, realtime and worker return private ready JSON. Secret-bearing environment files are
never printed.

The workflow installs both reviewed primitives, writes `backup.complete` last, and records the
deterministic snapshot directory in the job log without printing its contents. A validate-only
preflight proves the saved Compose/digest set and local previous runtime images before any release
file is overwritten. Any later failed or cancelled deploy step invokes the rollback primitive
automatically. A successful workflow retains
both the application snapshot and its separate PostgreSQL custom-format archive as release
evidence. Rollback never runs a downmigration; expand-only schema changes remain applied.

The temporary legacy OTP canary has a stricter rollback-only contract. Its durable marker is
`/opt/phub/.legacy-otp-hotfix.transition.env`; after opening the fixed browser window, the workflow
always restores the exact e308 `release.env` and its locally retained web/API/worker/realtime image
digests. It never keeps the candidate active and never restores the PostgreSQL archive
automatically. On interruption, run the same workflow with `RECOVER`, the original control SHA,
run ID and attempt, and `RECOVER_LEGACY_OTP_HOTFIX_CANARY`. A missing marker is accepted only when
the exact e308 manifest, images and health already attest as restored. Do not proceed to B0 or any
other staging workflow while the marker or `.next` files exist. RECOVER validates and removes only
the exact regular, single-link, controller-owned `0600` OTP `.next` artifacts; malformed metadata
or a symlink retains the marker and requires investigation rather than manual deletion.

For `MEDIA_BINARY_ONLY`, the workflow records only an `ordinary` or `client-media` pre-cutover
baseline before build and repeats the same read-only classification immediately before the
snapshot. An active `community-logo` floor is rejected and must use the dedicated stable-to-stable
rollout path below. The database archive must restore successfully into a new isolated local
PostgreSQL 16 clone; the exact candidate migrator must pass, run a second time without applying
anything, satisfy the complete ledger/RLS/constraint gate and confirm clone deletion before the
shared database is migrated. A changed active release, effective runtime/routing fingerprint or
rollback floor stops before deployment. Feature enablement and compatibility backfill are never
part of this binary-only path.

## Stable community-logo cutover

After `integration.media_cutover_state` records `community_logo_stable_delivery` as active, do not
restore an API without the stable media route directly. Automatic recovery of a failed repeat deploy
is stable-to-stable: restore the saved `true/false` worker, require the recorded
`phub.community-logo-rollback.v1` capability and immutable digest, verify stable mappings twice and
drain the Home queue, then preserve that worker while restoring the saved compatible API. The
workflow identifies this state with precheck exit `43` and uses
`PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo` together with
`PHUB_MEDIA_ROLLBACK_MODE=compatible-logo` for the prepare, guard and rollback sequence.

Client-assisted profile media without an active community-logo cutover is a separate compatibility
floor. Precheck exit `42` selects `PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media` and
`PHUB_MEDIA_ROLLBACK_MODE=compatible-client`; that path requires only the client-media capability
and preserves the saved `false/false` worker. Stable-logo evidence always takes precedence over the
client-only classification. Crossed flags, pending client commands or an unresolved stable mapping
fail closed instead of selecting either automatic rollback path.

A deliberate feature rollback is separate. Run the compatible worker with stable delivery disabled
and compatibility backfill enabled until signed logo mappings, Home projections and the Home
projector queue converge. Disable backfill, restart the worker, then require
`PHUB_MEDIA_ROLLBACK_MODE=feature sh /opt/phub/verify-media-rollback-safe.sh`. The guard checks the
running flags, validates convergence twice, stops the worker, rechecks the queue and only then clears
the cutover marker. Migrations `0079` through `0083` remain applied in both rollback paths.
