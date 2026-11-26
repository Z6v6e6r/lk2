# Timeweb migration 0120 for game invitations

This operation advances the LK2 production schema from the committed `0119`
to `0120_game_friend_invitations.sql` on the enrolled Timeweb database. The
operation uses the existing root-owned Timeweb controller and leaves application
containers running. The invitation feature is enabled by a separately verified
application release after the migration receipt is sealed.

## Enrolled inputs

- Verify current `main`, exact-head CI, the canonical publication, the enrolled
  controller SHA/tree and the existing installed API/Web release
  `dd73c7e02e81ad790f9c8c3ceb9f9ca988ad87a5-45820580791-1`.
  Stale or changed inputs stop the operation.
- Verify the existing `0119` COMMITTED receipt, PostgreSQL 16 container and system
  identity, primary role, both shared delivery markers free, no active migrator,
  and exact 123-row ledger ending in `0119`. Require the new relation to be absent.
- Use a fresh full dump with `PG16_TOC_PARSE_VERIFIED` under the existing
  [backup producer](timeweb-prerequisite-producers.md#standalone-backup-tool).
  The owner waived independent restore verification for this operation only.
  The receipt records `freshDumpRestored: false`.
- After approving the exact controller and backup helper installation, put
  the exact owner message bytes in the root-only
  `/opt/phub/timeweb-beta/operator/game-invitations-0120-restore-waiver.txt`.
  Seal the companion `game-invitations-0120-restore-window.json` as
  `PHUB_TIMEWEB_GAME_INVITATIONS_0120_RESTORE_WINDOW_V1` with
  `messageSha256`, exact `candidateSha`, `controllerTree`, `releaseId`,
  actual user message `receivedAt`, operation window `openedAt` after exact source
  CI and immutable publication, and UTC `expiresAt` within one hour of
  `openedAt`. The request records a hash of the exact backup scope and uses this
  same deadline through migration and activation. Preparing another attempt
  cannot extend the window. The user message timestamp is recorded separately
  from the opening of the operational window.
  The backup producer's existing `--prepare-app-only` entry takes the new
  `game-invitations-0120-integrity-only` selector after the exact source SHA and
  publication run ID. Use its existing plan, execute, and reconciliation stages.
  Keep the archive, original operation, snapshot witness, and integrity receipt.
- Check capacity against the backup producer immediately before the dump. If
  capacity is insufficient, stop before the dump. An earlier release's backup
  is outside the 0120 backup admission.

## Apply and verify

Use the enrolled controller's read-only
`--critical-game-invitations-0120-prepare <backupReleaseId>` entry to derive the request
from the completed backup and scoped owner decision. After approval of the exact
request, install it exclusively as root-owned 0600 at
`/opt/phub/timeweb-beta/operator/game-invitations-0120-migration.json`.
The request schema is `PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1`. Bind the
UUID v4 attempt, exact enrolled `controllerSha`, same `migrationSourceSha`, running
`postgresContainerId`, UTC `expiresAt` within one hour, canonical `backupReleaseId`,
`retainedBackupReceiptSha256`, and the `externalRestoreDecision` containing the
enrolled owner, `OWNER_WAIVED_EXTERNAL_RESTORE_FOR_GAME_INVITATIONS_0120`, and
SHA-256 of the exact owner message bytes and the backup decision digest. Confirm the archive was completed
within the hour before migration.

Run the enrolled controller with `--critical-game-invitations-0120` and that
request path. The existing host markers and advisory key `7140221` serialize
the operation. The existing database owner `phub_beta` runs the exact migration
over the local socket and transfers only the new table to `phub_migrator` before
committing the ledger row. PostgreSQL transfers the invitation grants with the
table. The transaction verifies their exact grantor, privileges and ownership,
the tenant policy and FORCE RLS, parent identity and role/schema ACLs. No extra
grants on existing objects are necessary.

A terminal `COMMITTED` receipt requires the exact 124-row ledger, matching ACL
and schema readback, and a read-only table probe as `phub_runtime`. Retain the
receipt along with the existing release witnesses. Check application readiness
and the previous component identities before any application release.

If the SQL fails, exact preimage verification is required before sealing
`ROLLED_BACK`. In case of an uncertain response, use only
`--critical-game-invitations-0120-reconcile` with the same retained request.
Reconciliation never executes the migration. Keep locks on ambiguous results
until the enrolled procedure can resolve them. Application rollback uses prior
images and retains the expanded schema and history. Database restoration is a
separate recovery operation.

## Activate the application from PR 709

The activation schema is `PHUB_TIMEWEB_API_WEB_GAME_INVITATIONS_0120_V1`.
It admits only the product tree from merge `53af9f2e114de228a9b26fcbcf7ef7e284bd85f4`
with the reviewed controller-only additions. Publish the exact final main
commit after first-attempt main CI. The app operation uses the published API
and Web digests. The current Worker already handles the established in-app
notification contract. This profile continues to verify the excluded Worker,
Realtime, and Migrator states.

Before starting the backup or migration, verify the normal production provider
and alert evidence with `--critical-game-invitations-activation-monitoring`.
The restore decision applies to the backup only. The ordinary 15-minute
monitoring checks still run.

After a COMMITTED migration, use
`--critical-game-invitations-activation-prepare <sourceCiRunId> <publicationRunId>`
on the enrolled controller. This reads the canonical artifact, the original
pre-migration backup and its terminal integrity evidence, and the sealed
migration request and receipt. It checks the 124-row ledger and ACL/RLS
postimage on the same PostgreSQL instance. It prints the validated operation
for exclusive installation as root-owned 0600 at
`/opt/phub/timeweb-beta/operator/api-web-upgrade.json`. Use the existing
`--critical-api-web`, recover and reconcile commands with that request path.
The operation requires sufficient time in the same backup window for the
standard observation.

Before the first API change, the controller rehashes the dump and verifies that
the invitations table is empty using the database operator without RLS
filtering. It verifies the 0120 postimage before API and Web start, before
sealing the installed baseline, and after a binary rollback. A rollback retains
the table and any invitation rows. If private invitations were issued, users
may temporarily lose access to those games while the previous API is installed.
A later forward release can recover that access using the retained rows.
