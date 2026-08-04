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
`tls-ingress/Caddyfile`, the prior `staging.override.env` state and a `backup.complete` marker
written last with the previous release SHA.

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
