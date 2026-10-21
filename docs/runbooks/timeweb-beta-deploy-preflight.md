# Beta deploy preflight (read-only fitness check)

Companion to [ADR 0025](../adr/0025-two-profile-timeweb-delivery.md). Use for the `beta` profile
before any approved transition. This document is the checklist; the automated read-only command is
`scripts/preflight-timeweb-beta-deploy.ts` (see below). Host prerequisites (roles, secret sets, FCM
custody, monitoring evidence) are covered by the
[bootstrap readiness plan](timeweb-beta-bootstrap.md).

Preflight is **read-only**. It must never restart a container, write to the database, publish an
image, change a lock or alter a secret. Every category below reports `GO` or the exact missing
input, so the operator learns the full gap list in minutes instead of discovering it mid-operation.

Evidence labels: `LOCAL`, `CI`, `STAGING`, `PROVIDER`, `PRODUCTION` are distinct; never report one as
another.

## Automated command

Run the read-only check from the enrolled controller source on the target host:

```sh
cd /opt/phub/timeweb-beta/standard/source
node --import tsx scripts/preflight-timeweb-beta-deploy.ts \
  --profile=beta --phase=rollout
```

Options:

- `--profile=beta|production` (default `beta`);
- `--phase=pre-migration|post-migration|rollout` — selects the expected ledger
  (`025c5ee1…` for pre-migration, `b9bfd91a…` for the 102-row post-migration/rollout state);
- `--candidate-dir=/etc/phub/timeweb-beta-candidates/<release-id>/timeweb-beta` — validates the
  prepared candidate secret set and FCM delta;
- `--expected-current-secret-set=<release-id>` — pins the installed `.release-identity.json`;
- `--ci-run-id=<github-run-id>` with `GITHUB_TOKEN`/`GH_TOKEN` — verifies the controller main-push CI;
- `--json` — machine-readable report; `--pg-container`, `--root`, `--source`, `--config`, `--env-dir`,
  `--candidate-release-id` override host defaults for staging or tests.

Exit codes: `0` = `GO` (only warnings/evidence gaps), `1` = `NO_GO` (at least one blocker),
`2` = the preflight itself could not run. The command never mutates the host, database, secrets,
images or locks; it is safe to run before every attempt and after a failed attempt to see what was
left behind.

## Restore mode planner

The restore operation schema is selected from the real database size and host capacity, never from
the previous attempt:

```sh
cd /opt/phub/timeweb-beta/standard/source
node --import tsx scripts/plan-timeweb-beta-restore.ts --phase=post101 --json
```

The planner is read-only. It prints `storageMode` (`namespace` or `disk`), the exact operation
`schema` (`PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1` / `..._DISK_NAMESPACE_V2` for post-101,
`PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_V1` / `..._DISK_NAMESPACE_V2` for pre-99) and
the capacity detail. It exits `1` with `NO_RESTORE_CAPACITY` before any mutation when neither mode
fits the host. Use the printed schema in the backup-restore operation request; do not hand-edit the
schema after the planner decided it.

The planner and the preflight share `scripts/timeweb-restore-capacity.ts`. The namespace (tmpfs)
mode stays the first choice for small databases; disk (LUKS/loop) becomes the default automatically
once `3 × pg_database_size + reserve` no longer fits available memory.

## 1. Authority and target (PRODUCTION)

- [ ] Exact target is `lk2.padlhub.su`, server `8886471`, project `262717`, host
      `msk-1-vm-z8ks` (x86_64), tailnet address present.
- [ ] The transition and its profile are explicitly authorized for this source, artifact and target.
- [ ] Rollback material for API/Worker exists: previous image digests, previous secret set, and a
      tested rollback path. Code rollback never reverses migrations or external writes.

## 2. Source and CI (CI)

- [ ] Controller commit and tree are green on a main-push CI run (`run_attempt=1`, required jobs
      successful, branch `main`).
- [ ] Source checkout is clean, at the controller commit, root-owned and mode `0700`; tracked files
      are `0644`/`0755` as required by custody checks.
- [ ] The delivery contract in that checkout is the reviewed one for this operation (profile,
      confirmation tokens, pinned patch tuples).
- [ ] Candidate publication manifest/artifact are immutable and match the bridge: candidate SHA/tree,
      publication run, artifact id/digest, manifest SHA, API/Worker digests and revisions.

## 3. Images and artifact (PROVIDER/LOCAL on host)

- [ ] Candidate API/Worker images are already present locally by **digest** (no build on the host,
      no `latest`); `image inspect` revision matches the candidate SHA.
- [ ] Canonical artifact and manifest are present and hash-verified where the profile requires it.
- [ ] No unrelated containers are running; the expected container boundary hash is computed from the
      current ids and recorded in the operation.

## 4. Database and roles (PRODUCTION)

- [ ] Current ledger equals the expected pre-state; packaged ledger matches the candidate
      (102 migrations for `8158ac44…`).
- [ ] Runtime and migrator roles exist and satisfy the operation's privilege model. Beta requirement:
      distinguish runtime/migrator where supported by the profile; never "fix" a role model during a
      release.
- [ ] The migrator image is local by digest; migrations run as a one-shot, never on API startup.
- [ ] No active migrator container, no live migration transaction/lock, no partial ledger.

## 5. Backup and restore capacity (PRODUCTION)

- [ ] Verified pre-transition backup exists, and its receipt passes the profile validator
      (ledger digests, baseline identity, dump hash). If the profile allows a degraded proof, the
      authorization and the missing-receipt reason are recorded in the receipt/operation.
- [ ] Restore mode is chosen by the read-only planner from real database size and host capacity
      (`node --import tsx scripts/plan-timeweb-beta-restore.ts --phase=... --json`); the emitted
      `schema` is copied into the operation request unchanged. Preflight prints database bytes,
      available RAM, free disk and the required reserve.
- [ ] Disk restore prerequisites are present: `cryptsetup`, loop devices, LVM/dm tools, private mount
      propagation path for the chosen execution namespace, and sufficient free space for image and
      dump.
- [ ] Audit/outbox growth is within budget; a database that is mostly `audit.outbox_events` bloat is
      flagged before it blocks a backup.

## 6. Secrets and FCM (PRODUCTION)

- [ ] Installed secret set is the expected release id; its file hashes match the operation.
- [ ] Candidate secret set exists under the private candidate directory, root `0700`/`0600`, and
      differs from the installed set only in the allowed FCM delta (`FCM_ENABLED`, `FCM_PROJECT_ID`,
      `FCM_APP_ID`, `FCM_ENVIRONMENT`, `FCM_CREDENTIAL_FILE`).
- [ ] FCM credential exists at the canonical root-only path with the expected owner/mode; the
      operation checks metadata only and never prints the key.
- [ ] No ambient Compose/Docker overrides in the operator environment.

## 7. Monitoring and evidence (PROVIDER)

- [ ] Monitoring provider readbacks exist with the canonical schema and provider monitor ids, or the
      profile explicitly marks monitoring evidence as non-blocking and records that decision.
- [ ] If readbacks are required by the profile, they are fresh at the moment of the check and the
      operation does not re-validate a wall-clock snapshot after a multi-minute apply.
- [ ] Alert delivery/recovery/ack evidence is attached to the receipt by hash.

## 8. Locks, transactions and host hygiene (PRODUCTION)

- [ ] No foreign `standard/active` pointer, provision lock, transaction directory, plan/journal or
      interrupted capsule from another operation.
- [ ] No restore containers, dm/loop devices or mounts left by previous attempts; slices/units are
      stopped and not loaded.
- [ ] Free disk and memory meet the preflight thresholds; no swap thrash or OOM pressure.

## 9. Post-transition verification (PRODUCTION)

- [ ] Readiness endpoint `200` and expected health for API/Worker/Realtime/Web.
- [ ] Packaged ledger equals live ledger; no unknown or legacy entries.
- [ ] One smoke operation against the candidate (or the profile's documented smoke target) passes.
- [ ] Rollout receipt is `SUCCESS`; reconcile it to release owned locks, or record the exact gate
      that makes reconciliation inapplicable (for example provider gates already enabled).
- [ ] Monitoring observation window passes (or is explicitly recorded as non-blocking), and the
      result is attached to the receipt.

## 10. Feature activation (separate operation)

- [ ] Provider/tenant activation is a separate approved operation after a green deploy.
- [ ] Capability API reports the intended channel state before any user-visible test.
- [ ] For a device test: exactly one active matching endpoint, no latent nonterminal deliveries or
      leases, and a strict one-recipient campaign with a command key.
- [ ] Foreground, background and tap navigation are verified on the physical device; a queued push is
      not "delivered".

## Go/no-go summary

| Category                  | Blocker on `beta` | Blocker on `production` |
| ------------------------- | ----------------- | ----------------------- |
| Authority/target          | yes               | yes                     |
| Source/CI                 | yes               | yes                     |
| Immutable images/artifact | yes               | yes                     |
| Database roles/ledger     | yes               | yes                     |
| Backup + restore capacity | recorded          | yes                     |
| Secrets/FCM custody       | yes               | yes                     |
| Monitoring readbacks      | recorded          | yes                     |
| Locks/host hygiene        | yes               | yes                     |
| Readiness/smoke/reconcile | yes               | yes                     |

Only a full `GO` table authorizes `apply`. Missing inputs are fixed **before** any mutation; never
weaken a gate under time pressure without an explicit written authorization and an ADR/runbook
update in the same change.
