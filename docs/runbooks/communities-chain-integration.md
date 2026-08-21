# Communities chain integration

## Scope and authority

This runbook integrates the canonical Communities implementation without activating it. Canonical
reads and every command remain disabled unless the server advertises the explicit
`communityCanonical` capability. Legacy read-only projections remain the default migration mode.
Media, realtime, invites, worker processing and data import require their own release gates.

Database migrations are forward-only. Application rollback may restore the previous image and
runtime flags, but must never remove an applied migration or rewrite `schema_migrations`.

## Historical ledger contract

The first Communities release was applied under the shifted filenames below. These exact files and
checksums are immutable and must remain packaged:

| Filename                                     | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `0053_profile_visibility_sections.sql`       | `b6c7603110b6c208b11b274f5b7f9ff0eb3bf0ebacdb986201b3e9c944286266` |
| `0054_community_membership_pin_commands.sql` | `e4fdedbccd25d4ffc656029dbe7220ad465b577ff2aa4ec4ee4a369cf533150e` |
| `0055_community_create_commands.sql`         | `2e55fdaf1a67cc870625d32cc7743ab0e68c8a9fc2f86a27bc18b0d7fa10d1a7` |
| `0056_community_discovery_indexes.sql`       | `59cf2f3eaf4bb65699884e9ef3702937b3c43c88bd0d3779afd3658b02b453e7` |
| `0057_community_membership_lifecycle.sql`    | `f6bd497d9445efc5b750ebd6e8412a4a35276ffc69af4c4f5a615185aa767f35` |
| `0058_community_direct_invites.sql`          | `f8c8245e25e83236587c75546b007d2fbcfc55f1e510e1770dc2e7bb0e472e10` |
| `0059_community_direct_invite_quotas.sql`    | `cf2040b77106515bbe986f503886576049bcf33dd24c303936c97dca9cff5e5d` |
| `0060_viva_home_booking_ownership.sql`       | `5b74d85ef678639694c9074f8a66eb5df6b243f60b1b6f429eced3f0b09d5f38` |
| `0061_community_mine_keyset_index.sql`       | `1caf9857dff642fb577a3713fa330b2e413670ec3f5e622582d2a6b17df78413` |
| `0062_community_ownership_transfers.sql`     | `58df5b8539a0bb29bb74e2c149d438adb4c831a0dc9295c31f13a471ff12e998` |
| `0063_community_content_foundation.sql`      | `515baca7fd0d897ee02308e4a23f5b09aef7a303bbefbe835e379a63a4f4c05d` |
| `0064_community_durable_events.sql`          | `3a7aead3d0b0c62a8a53d89a3d19a2008bee5896ae04a3bfe70a47d35d204072` |
| `0065_community_content_moderation.sql`      | `d48f63eaabcadef0d376d148ef6225cc8f5eb2423ae11d0c8a143d83d6a0ebe1` |
| `0066_community_member_count_projection.sql` | `b228b50810a62a0ba609fb7ab67d5ef9bbf60bbd875e108aae03c91035eb5e49` |
| `0067_community_media_lifecycle.sql`         | `1653d039325452ca8ef0e88fb78a96863b928fae52688e3cd20e83f1fe16f0eb` |
| `0068_community_event_retention.sql`         | `94c959a60eeb02ad7308453cf7b99fbf38919900475091e3b025133f4fc3a2f8` |

The superseded canonical filenames `0060_community_membership_pin_commands.sql` through
`0075_community_media_operational_recovery.sql` must never be inserted as aliases. Their presence
means the target has an incompatible or mixed history; both migration entrypoints fail before DDL.
Every other ledger filename must be present in the packaged release except these exact reviewed
legacy messaging migrations:

- `0043_messaging_runtime.sql` with checksum
  `32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465`; the existing 0056 alias
  migration verifies its full schema before recording the current 0057 filename;
- `0044_contextual_messaging_projection.sql` with checksum
  `103976b96034ac3996c47c9adc536d22c06c5bc0ad12352af1413241b9c50832`; this expand-only
  historical migration created the default-disabled contextual projection inbox. It is accepted
  only under this original repository checksum and does not replace any packaged migration.

New changes continue from:

- `0076_community_create_quota_grants.sql`
- `0077_community_media_operational_recovery.sql`
- `0078_community_media_issue_quotas.sql` (`SHA-256
d91ad275840ca32a35a626fd0cfa4900cc21f2469d986923326c6522740de365`)
- `0079_profile_photo_client_assisted_source.sql`
- `0080_community_logo_stable_delivery.sql`
- `0081_community_logo_stable_delivery_validate.sql`

Migration 0078 creates four ordinary indexes on `community_content.media_assets`. Before applying it
to a shared target, record the relation row count and size, measure all four index builds on the
restored clone, and approve explicit lock and statement timeout budgets. A no-traffic clone result
does not prove an acceptable production writer pause.

## Required preflight

1. Freeze one immutable release digest and record the target database identity.
2. Query `public.schema_migrations` read-only and compare every packaged filename checksum.
3. Stop on any unknown filename, superseded canonical filename, mixed history or checksum
   mismatch.
4. Take a PostgreSQL backup and record its checksum, size, tool versions and restore command. A
   readable TOC is not sufficient backup evidence.
5. Restore the complete backup with `pg_restore --exit-on-error` to a clean isolated PostgreSQL 16
   database with no application traffic. For the split-role media suffix, retain and apply the exact
   same-cluster owners and ACLs; a portable `--no-owner --no-acl` restore is backup evidence but is
   not a valid bounded-migrator rehearsal. Require the restored ledger to be queryable before any
   migration is run against the shared target.
6. Classify the exact missing-filename set before running any migrator against the clone:
   - if none of the maintenance-only chat/push migrations `0069`–`0073` are pending, pass the clone
     `media` role precheck, run the built `apps/migrator` image against the clone, run it again and
     require no output, then pass the role postcheck and rolled-back runtime tenant DML/RLS probe;
   - if the pending set is exactly the reviewed 29-file staging set recorded below, use only the
     three-phase clone-only rehearsal contract. It applies `0053`–`0068`, then `0069`–`0073`, then
     `0076`–`0083` to a newly restored clone and performs an ordinary no-op migrator invocation only
     after all three phases pass. It never targets the shared database and never resumes a partially
     applied clone;
   - for every other pending set, stop without invoking the migrator. This Communities procedure
     has no reviewed clone mode that combines the chat/push maintenance acknowledgement
     with the required media role precheck, postcheck and rolled-back runtime tenant DML/RLS probe.
     Complete the separately authorized maintenance procedure in
     `docs/runbooks/chats-notifications-moderation.md`, then restart this preflight from a fresh
     inventory whose `0069`–`0073` pending set is empty. If any other packaged migration is pending
     alongside `0069`–`0073`, the current policy also returns
     `CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING` before DDL.
7. Compare Communities row counts before and after; require all indexes valid and all Communities
   tables to have both RLS and FORCE RLS.
8. Validate existing `NOT VALID` Communities constraints in a transaction and roll it back.
9. Exercise an intentionally mixed clone and require `COMMUNITIES_CANONICAL_HISTORY_REJECTED`
   before any missing migration is written.
10. Before and after migration, count `profile.privacy_commands` rows whose `result_payload` lacks
    `visibilityMode` or `sections`. The exact historical 0053 backfill runs against a FORCE-RLS
    table; any non-zero post-count requires a separate forward tenant-scoped repair and blocks
    activation. Record that the migrator and audit role has `rolsuper` or `rolbypassrls`; otherwise
    a zero visible count is not valid evidence for this backfill.
11. Only after CI and independent migration/security review may the code release be merged.

### Dedicated staging evidence workflow

`.github/workflows/communities-staging-preflight.yaml` is the only workflow for collecting this
target-bound evidence. It is manual, accepts only `main`, pins the exact 40-character event SHA,
shares the `staging` concurrency group, and has no migrator, deploy, restart or application process
step. Its successful report explicitly does not authorize migration, deploy, import or activation.

The workflow must not reuse `STAGING_DEPLOY_KEY`. Before its first use, an authorized staging
administrator must install these repository-matched files as root-owned, non-writable commands:

- `/usr/local/libexec/phub/inspect-communities-staging-target.sh`;
- `/usr/local/libexec/phub/create-communities-staging-backup.sh`;
- `/usr/local/libexec/phub/verify-postgres-backup-restore.sh`.

Provision two distinct SSH principals or keys with `restrict` and exact forced commands in
`authorized_keys`:

```text
restrict,command="/usr/local/libexec/phub/inspect-communities-staging-target.sh" <inventory-public-key>
restrict,command="env PHUB_BACKUP_ROOT=/var/lib/phub-preflight/backups /usr/local/libexec/phub/create-communities-staging-backup.sh" <backup-public-key>
```

The inventory key is stored as `STAGING_PREFLIGHT_INVENTORY_KEY` in the protected `staging`
environment. The independently approved backup key is stored as `STAGING_PREFLIGHT_BACKUP_KEY` in
the `staging-backup` environment, which requires manual approval. Both use the pinned
`STAGING_PREFLIGHT_KNOWN_HOSTS`; neither principal may receive a shell, port forwarding, arbitrary
Docker, migrator or deploy access. Installing or rotating these principals is a separate privileged
administrator action and is not performed by the workflow.

The forced-command account is a dedicated non-root account. It may have only the group access
needed to read the fixed infrastructure inputs and invoke Docker through these commands. It must
not own or be able to write `/opt/phub`, `infrastructure.env`, `compose.infrastructure.yaml`,
`release.env` or an optional `.env`; both commands reject writable or same-owner inputs. The backup
directory is the separate exception and is private to the backup command.

Both commands require a non-empty exact `SSH_ORIGINAL_COMMAND`; a connection that supplies no
requested command fails closed. Each installed script also establishes a host-side GNU `timeout`
process group (10 minutes for inventory, 150 minutes for backup/restore), terminates remaining
children after a 30-second grace, and runs the backup cleanup trap on termination.

The administrator pre-creates `/var/lib/phub-preflight/backups` as mode 0700 and owned by the
dedicated forced-command account. Do not reuse or chown `/opt/phub/backups`: it belongs to the
existing deploy backup lifecycle and has a different owner. The exact backup root is pinned in the
forced command above and is used for both the private archive and restore-cleanup markers.

The protected staging environment also pins `STAGING_PREFLIGHT_DATABASE` and
`STAGING_PREFLIGHT_SYSTEM_IDENTIFIER`. Record them through the approved DBA inventory channel;
never derive either expected value from the same remote evidence being checked. The database role
used inside the forced command must have BYPASSRLS (or superuser) for tenant-wide row evidence and
usable `pg_read_all_stats` visibility (or superuser) for transaction evidence.

The protected `staging-backup` environment independently stores the same approved database and
system-identifier pins. GitHub job outputs carry only a SHA-256 phase commitment, never those exact
secret values; the backup job recomputes that commitment before SSH. The requested forced command
also carries the exact checked-out backup-wrapper and restore-helper SHA-256 values. The installed
wrapper verifies both files before capacity inspection or any filesystem/database mutation, while
the inventory phase independently reports their installed hashes. All third-party workflow actions
are pinned to full commit SHAs, not mutable major-version tags.

Run `INVENTORY_ONLY` first with confirmation `INVENTORY_COMMUNITIES_STAGING`. The remote command
uses one bounded `REPEATABLE READ READ ONLY` transaction and emits only release, database identity,
role capability, relation sizes/counts, lock/index/RLS summaries and the complete migration ledger.
The runner verifies the installed command SHA against the checked-out file and fails closed on an
unknown, superseded canonical, duplicate or checksum-mismatched ledger. Compatible historical gaps
are reported as explicit missing filenames and are not treated as a prefix violation. That report
is compatibility evidence, not blanket execution authority: before a clone rehearsal, classify it
against the maintenance-only chat/push `0069`–`0073` policy in step 6. Any pending `0069`–`0073`
file must stop this Communities rehearsal without invoking the migrator; after separately approved
foundation maintenance, restart from a fresh inventory.

Run `BACKUP_RESTORE_VERIFY` only after separate backup authority, with confirmation
`BACKUP_RESTORE_COMMUNITIES_STAGING`. It repeats the inventory gate, creates a private mode-0600
archive, requires the source ledger to stay unchanged during `pg_dump`, restores to a temporary
PostgreSQL 16 database, compares the source and clone ledger digests, proves the temporary database
was dropped, then retains the verified archive. The workflow also requires the source database,
cluster system identifier, active release and ledger digest to equal the immediately preceding
inventory job inside the forced command before capacity inspection, `pg_dump`, clone creation or
archive retention. The runner repeats the equality check before it publishes the backup evidence.
Failure evidence and cleanup markers remain available for reconciliation; an unresolved marker
blocks subsequent attempts.

Neither preflight operation applies migration 0078, so its four index build durations remain
`UNMEASURED` until the separately authorized staged rehearsal runs. That rehearsal records one
isolated-clone, transactional `REINDEX` duration for each exact 0078 index after verifying the
complete manifest, then rolls each measurement transaction back. These figures are conservative
lock/storage-budget evidence, not the original first-build timings on the shared database.

### Clone-only staging role-split preparation (no live apply)

`communities-staging-role-split-clone-v1` is a preparation-only contract for the separate
runtime/migrator PostgreSQL role split required before a new Communities rehearsal. It is not part
of `33_V1`, is not dispatched by a workflow, and does not authorize a role change, shared database
operation, deploy, migration, import or activation. Its confirmation
`PREPARE_COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_V1` accepts only an exact marked
`phub_restore_<run>_<attempt>` clone, a separately supplied different shared database name, a
cluster-system-id pin and the canonical manifest SHA. It requires pre-existing, distinct login
roles with no superuser, BYPASSRLS, database/role creation, replication or memberships; it never
creates or alters roles.

The v1 provisioner intentionally opens a bounded `REPEATABLE READ READ ONLY` clone transaction,
verifies the database, executor/session role, clone and shared database owners, role OIDs, ledger,
clone-source marker and redacted catalog inventory, takes an advisory transaction lock, and terminates with
`COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_REQUIRED`. It emits no `REASSIGN OWNED`, wildcard,
`GRANT ALL`, owner transfer or default-ACL mutation. A later version may be designed only after a
fresh restored-clone inventory proves the exact current owner/ACL state for the explicit object
manifest (including `public.schema_migrations`, `profile.privacy_settings`, Community, Integration,
Notification and Games targets). Mixed ownership, PUBLIC grants, grant options, column ACLs or
third-party grants are a hard NO-GO before any mutation.

Do not expose `/etc/phub/staging.env`, `/etc/phub/staging.migrator.env` or
`/etc/phub/realtime.env` to `phub-preflight`. The rehearsal credential contract projects only the
two database URLs into separately root-owned, `phub-preflight` group-readable `0440` files, each
containing exactly one `DATABASE_URL=...` line. The forced command validates ownership, mode,
single-link status, one-line grammar and distinct inode and URL without printing either value.
Realtime isolation is represented by a metadata-only `0440` receipt; it binds the current API,
realtime and optional override file identities, the disabled realtime state, the verifier SHA-256
and both projected credential identities. It contains no URL, JWT or secret hash. Creating the
database roles, installing or refreshing these files, workflow wiring or any live application
change remains a separately approved staging operation; merging the implementation grants no such
authority.

This is inventory preparation only; it is not a complete safe role split. A future DBA-reviewed
gate must first establish the exact clone preimage: `pg_trgm` state, intentionally absent
`community_content`/`eligibility` schemas, each exact CREATE requirement, database/schema/default
ACLs, table/column ACLs, RLS/policies, sequences, functions and types. Only that evidence can
support a separately versioned and approved persistent role/ownership/grant plan.

The independent inventory producer remains blocked until the restore owner creates a trusted clone
provenance marker. The current strict contract is
`PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_V2`; it derives the database comment value as
`phub-communities-role-split-clone-v2:<payload-sha256>`. In addition to the previously pinned
request, clone/source identity, system identifier, workflow, archive, ledger, release, PostgreSQL
major, manifest and helper fields, V2 binds an independently retained
`creationReceiptSha256`. The matching evidence is exact-key
`communities-role-split-clone-marker-evidence-v2`; the TypeScript validator recomputes the marker
payload and requires the same receipt digest. Redacted evidence contains only digests, counts and
booleans and states that role creation, role split, shared-database mutation, migration, deploy,
import and activation are all unauthorized.

`deploy/jetson/prepare-communities-role-split-inventory-clone.sh` is a non-runnable preparation
gate, not a marker writer. It accepts only
`PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 <request-basename> <request-sha256>`, where the
request is the exact-order, LF-terminated
`PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1` contract. Before stopping, it verifies the
root-owned request and command, the exact restore-helper SHA-256, the retained private
`postgres-communities-rehearsal-*` archive bytes/SHA-256, its root-owned `.evidence` companion and
all run, source, ledger, release, PostgreSQL 16 and object-manifest bindings. Even a completely
valid request terminates with
`COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_EXECUTION_NOT_AUTHORIZED`; the command has no
Docker, PostgreSQL, clone, comment, cleanup or role/ACL operation.

The repository now contains a reviewed, but uninstalled, two-invocation ceremony implementation.
`RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V2 CREATE` performs only the bounded exact
`createdb` attempt and always stops in `CREATION_RECONCILIATION_REQUIRED`; even an observed success
requires a separately prepared root-owned creation receipt. `RESUME` requires that receipt and its
independently supplied SHA-256, verifies the exact clone OID/name/owner and archive/ledger bindings,
performs the restore, and verifies and writes the COMMENT in one transaction while holding the
catalog lock. All container calls use a pre-pinned container ID, GNU timeout bounds the sanitized
child process group, and public output remains bounded and redacted.

Pre-marker failure and `CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1` intentionally do
not drop, rename or comment a database. They verify the exact observed OID/name/owner/comment and
write only `QUARANTINE_PENDING_RECONCILIATION_REQUIRED`, with
`authorizesDatabaseDeletion=false` and `authorizesDatabaseRename=false`. PostgreSQL 16 cannot run
`ALTER DATABASE ... RENAME TO` inside the transaction that holds the catalog lock, so a safe
rename/delete path is outside this implementation and requires a separately reviewed DBA
primitive. Do not improvise cleanup or treat quarantine state as deletion authority.

After valid V2 evidence exists, the clone-only producer can emit
`communities-role-split-input-c-v1`. It verifies a root-owned private category-to-role mapping
against `pg_roles`, emits only a canonical redacted mapping artifact, uses structured JSON machine
identities for quoted identifiers and overloaded functions, and records stable explicit/effective
ACL fields as sorted semantic entries that bind grantee, privilege, grant option, redacted grantor
evidence and occurrence identity. The acceptance evaluator requires independently pinned
before/after artifact hashes and mapping digest, compares the complete twelve-category manifests,
and proves every proposed ACL ADD/REMOVE and ownership row against the observed delta. A PASS is
review evidence only and grants no execution authority.

Do not install either command, create a forced-command key, add a workflow, place requests on
staging or collect a trusted inventory under this checkpoint. A separately owned local runner now
passes the real PG16 custom-format `pg_dump`/`pg_restore`, catalog, marker, INPUT_C artifact pin and
no-change-evaluator path against a disposable synthetic clone. The same contour now injects lost
restore/marker/evidence responses, evidence failure and pre-marker cleanup failure after real PG16
or filesystem side effects, and verifies fail-closed readback/resume without automatic restore or
artifact rewrites. This is ownership/ACL-preservation and failure-semantics proof for that synthetic
fixture only. It does not establish independently sourced clean-clone provenance or organizationally
independent artifact custody. Installation, the two host ceremony
invocations, trusted independently sourced before/after inventory production, any
role/ownership/ACL mutation and the DBA quarantine resolution remain separate gates requiring
separate approval. The inventory collector and artifact verifier remain read-only and never create,
repair or replace the marker.

The exact installation surface can now be packaged locally with
`npm run db:communities-role-split:installation-candidate`. The builder takes an independently
supplied commit SHA, disables Git replacement objects, rejects replacement refs and emits a private
canonical V7 manifest, independently pinned V4 host control ledger and digest receipt. V7 is
installable only as a disabled versioned code snapshot: a POSIX shell root installer, an
always-denied command and read-only canonical host sources. It requires no Node runtime on the
ARM64 host and
creates no active link, forced command, key, connection, credential or workflow mutation.
The V7 source set also includes the canonical inventory-preparation contract, verifier and CLI
source snapshots. They remain unwired and non-runnable; their presence does not authorize evidence
access, inventory collection or artifact publication. Ten further mode-0444 snapshots retain the
independently reviewed V3 durable host, coordinator, composition and authorization/evidence
contracts, plus the durable continuation host and envelope, without adding a compiled entrypoint,
runner wiring, key, credential or connection. The POSIX installer reconstructs the complete
canonical manifest from its fixed allowlist and control records before accepting the manifest
digest; freshly pinned policy changes and schema downgrades remain rejected.

Only `authorizes.installation` is true. The twelve binding codes remain required before execution,
and every key, staging, database, ceremony, cleanup, role-split, migration, deploy and activation
authorization remains false. The installer refuses overwrite/partial replay, verifies the
independent manifest, control and artifact-set pins plus installed readback, then publishes an
`INSTALLED_DISABLED` receipt. Producing or verifying the candidate is not installation approval;
installing it is not ceremony approval and cannot synthesize the separately custodied host
evidence.

### Exact 29-file staged clone rehearsal contract

The staging inventory associated with source-ledger SHA-256
`60f0d7e4f93db67c1cf0e3a145745402a9b6153182ed8355a58c7cb2094ec8a2` reported this exact pending
set:

- pre-foundation: `0053_profile_visibility_sections.sql` through
  `0068_community_event_retention.sql` as enumerated by
  `COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES`;
- foundation: the five maintenance migrations `0069`–`0073`;
- post-foundation: `0076_community_create_quota_grants.sql` through
  `0083_profile_photo_removal_commands_validate.sql` as enumerated by
  `COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES`.

The candidate migrator resolves this mode only when all of the following are true:

- `COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION=COMMUNITIES_STAGED_REHEARSAL_29_V1`;
- the phase is one of `pre_foundation`, `foundation`, or `post_foundation`;
- `DATABASE_URL` targets the exact `PHUB_RESTORE_DATABASE`, whose name matches
  `phub_restore_<run>_<attempt>`, on Compose service `postgres:5432`, with no URL options;
- the complete ordered pending set equals the expected set for that phase;
- the retained backup SHA-256 and restored initial ledger SHA-256 equal the approved backup evidence;
- a distinct root-owned private rehearsal release file binds the exact candidate SHA and immutable
  migrator image digest. The shared `/opt/phub/release.env` is never changed.

The rehearsal uses the ownership-preserving restore path in
`deploy/jetson/rehearse-media-migration.sh`. Before the first phase it verifies PostgreSQL 16,
same-cluster ownership, distinct runtime/migrator roles, exact backup and ledger custody, and the
media role boundary. Its input must be a newly authorized `postgres-communities-rehearsal-*`
custom-format archive created without `--no-owner` and without `--no-acl`. The path intentionally
rejects the existing `postgres-communities-preflight-*` archive because that portable backup omitted
ownership and ACL restoration commands. Before creating a clone it uses the archive TOC only as a
structural prefilter for the `profile.privacy_commands` owner plus ACL and default-ACL entries. The
authoritative role precheck after restore verifies the required object owners, grants and default
ACLs. It then requires the exact `Applied ...` transcript for all `16 + 5 + 8`
migrations, runs the ordinary migrator once with no staged variables and requires empty output,
records an authoritative infrastructure-superuser count of `profile.privacy_commands` rows missing
`visibilityMode` or `sections` before and after migration, requires the post-count to be zero, passes
the post-role check and rolled-back tenant DML/RLS probe, verifies the complete migration
manifest and media invariants, and drops only its marked clone. Any mismatch or partial phase drops
the clone; a failed or uncertain cleanup retains a marker and blocks a later attempt. After the
manifest check, it records four named clone-only quota-index `REINDEX` durations with transaction
rollback and requires `quota_index_measurements=4` in the final evidence line.

`.github/workflows/communities-staged-migration-rehearsal.yaml` exposes this contract only as a
manual, exact-main-SHA dispatch. It repeats the read-only inventory under the protected `staging`
environment, requires the exact ordered 29-file pending set, and carries only a SHA-256 phase
commitment into the separately approved `staging-rehearsal` environment. The second environment
must define `STAGING_REHEARSAL_KEY`, `STAGING_REHEARSAL_KNOWN_HOSTS`,
`STAGING_REHEARSAL_DATABASE`, `STAGING_REHEARSAL_SYSTEM_IDENTIFIER`, `STAGING_HOST` and a
short-lived `TAILSCALE_AUTHKEY`. Database and cluster pins must be approved independently of the
fresh remote evidence. The immutable migrator digest and SHA-256 of the strict candidate override
file are explicit dispatch inputs and must match the root-owned candidate release file below.

Build that prerequisite only through
`.github/workflows/build-communities-rehearsal-migrator.yaml`, dispatched from the exact reviewed
`main` SHA with confirmation `BUILD_COMMUNITIES_REHEARSAL_MIGRATOR`. The workflow runs the source
and migration gates, publishes only `phub-migrator` for `linux/arm64`, verifies its OCI platform,
source-revision label, exact in-toto `Statement/v1` attestations for SLSA provenance v1 and SPDX,
and emits the immutable image digest, migration-manifest digest and exact two-line candidate file.
The provenance request is pinned to `mode=max,version=v1`; evidence generation rejects legacy,
hybrid, duplicate, missing or additional predicate types. The retained artifact includes the raw OCI
index, runtime manifest and config, raw attestation manifests and statements, and decoded provenance
and SBOM. The digest-bound statement predicates must exactly equal those decoded bodies. Before
installation, record and verify the separate GitHub artifact digest shown in the build job summary
as well as every digest inside the evidence file. It has no GitHub Environment, SSH, Tailscale,
Compose, database, deploy or rehearsal authority. A successful build does not authorize installing
the candidate file and does not authorize the staged rehearsal.
If publication succeeds but evidence generation or upload fails, the run remains failed and its
tag and digest are not eligible for installation. Do not rerun that workflow attempt; dispatch a
fresh exact-main build, which receives a new run-unique tag and evidence bundle.

An authorized staging administrator separately verifies the successful build artifact, copies its
two-line candidate file without editing it, verifies the recorded SHA-256, and installs it as
`root:phub-deploy` mode `0440` at the bounded path below. Installation and rehearsal dispatch are
separate approval gates; neither is implied by the image build.

Before the next real run, an authorized staging administrator atomically reinstalls these
repository-matched files as root-owned, non-writable commands:

- `/usr/local/libexec/phub/run-communities-staged-migration-rehearsal.sh`;
- `/usr/local/libexec/phub/rehearse-media-migration.sh`;
- `/usr/local/libexec/phub/verify-media-migration-ledger.sh`;
- `/usr/local/libexec/phub/verify-postgres-backup-restore.sh`;
- `/usr/local/libexec/phub/verify-runtime-env-isolation.sh`;
- `/usr/local/libexec/phub/prepare-communities-rehearsal-credentials.sh`.

The last command is a root-only preparation/verification command, never the SSH forced command.
After separately confirming that the runtime and migrator PostgreSQL login roles already exist and
are distinct, the administrator runs it with the exact token and then verifies the result:

```sh
sudo -- /usr/local/libexec/phub/prepare-communities-rehearsal-credentials.sh \
  PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1 prepare
sudo -- /usr/local/libexec/phub/prepare-communities-rehearsal-credentials.sh \
  PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1 verify
```

`prepare` holds an exclusive lock, validates the canonical `0600` source files and runtime-secret
isolation, checks distinct source inode and URL, rechecks source fingerprints around commit, and
atomically installs only:

- `/etc/phub/communities-rehearsal/runtime.database.env`;
- `/etc/phub/communities-rehearsal/migrator.database.env`;
- `/etc/phub/communities-rehearsal/realtime-isolation.receipt`.

The directory is `root:phub-preflight` mode `0750`; all three files are
`root:phub-preflight` mode `0440` and single-link. `verify` is read-only. Either command emits only
one fixed status line and never prints credential values. Any source, override, verifier or target
identity change invalidates the receipt and makes the forced command stop before Docker, backup or
database access. Credential provisioning does not create or alter PostgreSQL roles or grants.

The strengthened `29_V1` wire binding has 17 fields and its successful evidence has exactly 31
lines. It is intentionally fail-closed across a partial installation: an old 15-field caller is
rejected by the new wrapper, while an old wrapper rejects the new 17-field call before Docker,
backup or database access. Do not dispatch until all installed command SHA-256 values match the
same merged revision and the 17-field contract test has passed.

Only after the root verification passes may the dedicated key retain this forced command:

```text
restrict,command="env PHUB_REHEARSAL_BACKUP_ROOT=/var/lib/phub-preflight/backups PHUB_RUNTIME_ENV=/etc/phub/communities-rehearsal/runtime.database.env PHUB_MIGRATOR_ENV=/etc/phub/communities-rehearsal/migrator.database.env PHUB_REALTIME_ISOLATION_RECEIPT=/etc/phub/communities-rehearsal/realtime-isolation.receipt PHUB_RUNTIME_ISOLATION_VERIFIER=/usr/local/libexec/phub/verify-runtime-env-isolation.sh PHUB_API_ENV_SOURCE=/etc/phub/staging.env PHUB_REALTIME_ENV_SOURCE=/etc/phub/realtime.env PHUB_STAGING_OVERRIDE_SOURCE=/opt/phub/staging.override.env PHUB_STAGING_GAMES_SOURCE=/opt/phub/staging.games.env /usr/local/libexec/phub/run-communities-staged-migration-rehearsal.sh" <rehearsal-public-key>
```

It must not be the inventory key, backup key or `STAGING_DEPLOY_KEY`, and it receives no shell,
forwarding, arbitrary Docker, shared migrator or deploy capability. The administrator separately
creates `/opt/phub/release.communities-rehearsal-<candidate-sha>.env` as root-owned mode 0400 or
0440 with exactly two lines: the reviewed `RELEASE` and `MIGRATOR_IMAGE_DIGEST`. Its SHA-256 is a
dispatch input. The command uses shared root-owned `release.env` only as the full interpolation
base, then applies this strict file as the final override. The administrator also installs the
reviewed `deploy/compose.staging.yaml` as root-owned
`/opt/phub/compose.communities-rehearsal-<candidate-sha>.yaml`; its SHA-256 is bound in the remote
command. The forced-command account may read the candidate artifacts and the three bounded files
under `/etc/phub/communities-rehearsal`, but it may not read the canonical runtime/migrator/realtime
environment files and may not modify any credential, shared release or runtime file.

The dispatch confirmation is `REHEARSE_COMMUNITIES_STAGING_29_V1`. Before any backup or clone
write, the forced command verifies its own and all three helper SHA-256 values, the root-owned
candidate release file, the complete migration-manifest digest, active release, source ledger,
database and system identifier. It then creates a new private
`postgres-communities-rehearsal-*` custom archive without `--no-owner` or `--no-acl`, requires owner,
ACL and default-ACL TOC evidence, and rechecks that the source tuple did not change during the dump.
Only that new archive can enter the bounded clone rehearsal. Failed attempts delete any newly
created archive unless the full clone rehearsal succeeds; clone cleanup remains marker-guarded.
Raw child stdout/stderr is not uploaded, while the successful artifact contains only the fixed
31-line allowlisted evidence contract: metadata (including contract version and pending-set SHA), four explicit false authorization fields, the
privacy backfill audit, four named rollback-only index timings and the final staged completion line.
The candidate image is pulled and digest-checked before the post-pull capacity gate and backup. Both
runner and host use bounded timeouts.

The workflow never changes shared `/opt/phub/release.env`, never targets the shared database with
the migrator, never starts an application process, and has no deploy, import or activation step.
Installing the commands/release file and dispatching the workflow are separate privileged actions;
merging this implementation grants neither authority.

### Reserved exact 32-file clone-evidence contract

The later staging inventory has the same ordered 29-file set plus these exact three files in a
fourth `eligibility_payment` phase:

- `0084_participation_level_eligibility.sql`;
- `0085_game_payment_confirmation_evidence.sql`;
- `0086_game_payment_provider_exercise_binding.sql`.

`COMMUNITIES_STAGED_REHEARSAL_32_V1` is a versioned, clone-only preparation contract. Its pending
boundaries are exactly `16+5+8+3`, `5+8+3`, `8+3`, `3`, then an ordinary no-op. The phase binding
must include the contract version and the SHA-256 of the ordered pending filenames; the current
32-file value is `f5ea040e4498a45310ad671f321e3044c33743ca7b0cbee7c72bc01ee9b6a91d`. Missing,
additional, reordered, partial or cross-version sets fail before DDL.

This is explicitly **not execution-ready**. The preparation branch pins the reviewed
`eligibility-payment-acl-v1` runtime matrix at SHA-256
`065df6510c35ea1be09dad9b6415b25c30543902837336739911555ec3dcad26`, but no authorized
schema-provisioning or workflow ceremony exists yet. Two image entrypoints now implement the
otherwise missing clone-only exact-grant and runtime-probe steps, but they are not wired into any
workflow, forced command or clone helper. The dispatch token
`REHEARSE_COMMUNITIES_STAGING_32_V1`, the forced command, the clone helper and the migrator request
policy deliberately fail closed before SSH, backup, clone, Docker, database-pool creation or DDL.
The versioned migration selector additionally rejects a 32-file request unless it carries this
exact matrix version and digest. Do not guess grants or add them as a rehearsal shortcut. The
versioned policy proves ordering and ACL intent; it is not an executable rehearsal path. A new
bounded authorization and an independently reviewed end-to-end clone ceremony are required before
enabling any 32_V1 execution path.

The matrix grants the runtime role only `USAGE` (never `CREATE`) on schemas `eligibility` and
`games`. It grants exact table privileges derived from current repository SQL: `SELECT` only on
`canonical_levels` and `activation_readiness`; `SELECT, INSERT` on
`player_level_commands`, `policy_commands`, `decisions` and `payment_snapshots`; `SELECT, UPDATE`
on `personal_invitations`; and `SELECT, INSERT, UPDATE` on `player_sport_levels`, `level_policies`
and `games.payment_confirmation_evidence`. Every matrix table must be migrator-owned, FORCE RLS,
have exactly its migration-defined permissive `FOR ALL TO PUBLIC` tenant-isolation policy, and have
no grant option, `PUBLIC` table/schema privilege, third-party grant or column ACL.
Both runtime and migrator identities must be distinct, non-superuser, NOBYPASSRLS roles with no
inbound or outbound role-membership edges. The migrator must own both schemas, retain `CREATE` on
them, and own the four
pre-existing `games` relations altered by migration 0084. Global or schema-specific default table
ACLs may not grant any non-owner privilege.

Because the bounded migrator is forbidden database-level object creation, a future clone ceremony
must first prove that schema `eligibility` was separately pre-created under authorized DBA control,
is owned by the exact migrator role, grants the runtime role `USAGE` without `CREATE`, and has no
public or third-party schema ACL. The read-only
`verify-eligibility-payment-acl-boundary` image entry now supports `pre` and `post` catalog
attestation under a 30-second statement timeout and safe `pg_catalog` search path. It never grants
privileges. `provision-eligibility-payment-acl` requires the exact matrix version/digest, the exact
`phub_restore_<run>_<attempt>` database, the exact
`PROVISION_ELIGIBILITY_PAYMENT_ACL_V1` confirmation and a migrator session with no role switch. It
accepts only a query-free `postgres:5432` Compose URL for that exact clone name. It
accepts only a wholly ungranted fresh relation set or the wholly exact idempotent state, rejects
partial/unexpected ACLs before mutation, issues only the ten static table grants in one bounded
transaction and runs the post catalog verifier before commit. It never creates schemas, revokes
third-party grants, changes default ACLs, uses wildcards or grants schema `CREATE`.

`verify-eligibility-payment-runtime-role` connects as the exact runtime role to that same clone,
requires `VERIFY_ELIGIBILITY_PAYMENT_RUNTIME_RLS_V1`, exercises the static matrix with zero-row
statements, inserts one tenant-local idempotency marker, proves it becomes invisible after changing
the tenant context, proves cross-tenant INSERT plus table DELETE and schema CREATE fail with
`42501`, and always rolls the transaction back. It emits only the fixed readiness line and never
prints tenant, user, role or object identifiers. Catalog verification plus the zero-row statements
remain authoritative for all four UPDATE grants; positive non-zero-row UPDATE on
`personal_invitations` and `payment_confirmation_evidence` additionally needs domain fixtures.

These two entrypoints are implementation evidence only. They have no standalone authority and the
existing four fail-closed 32_V1 execution boundaries must not be removed until a separately
approved clone ceremony binds their exact image digest, environment and order and adds real-PG
evidence for provisioner rollback/idempotency and runtime RLS denial.

The `32_V1` token stays frozen permanently. Its preparation contract is retained as historical,
reviewable evidence; it is not upgraded in place and cannot become an execution authorization.

### Exact 33-file executable clone rehearsal contract

`COMMUNITIES_STAGED_REHEARSAL_33_V1` and forced-command token
`REHEARSE_COMMUNITIES_STAGING_33_V1` define a separate clone-only ceremony. The ordered pending set
is the exact `32_V1` set plus `0087_cup_player_level_projection.sql` in a fifth `cup_projection`
phase. Its boundaries are `16+5+8+3+1`, `5+8+3+1`, `8+3+1`, `3+1`, `1`, then an ordinary no-op.
The SHA-256 of the ordered 33 filenames is
`3f61d60f27ab90bf4fe8498af29771b06925ece3b1ac6c7cac32b296d86c06d0`.
Missing, additional, reordered, partial or cross-version sets fail before DDL.

The phase binding also includes the exact
`eligibility-payment-cup-projection-acl-v2` matrix at SHA-256
`83cba43d957e8104fc91b139020342dc154f571155c5fadafe36874583310310`.
It extends the v1 matrix with `SELECT, INSERT, UPDATE` on
`eligibility.cup_player_level_projections` and `SELECT, INSERT` on
`eligibility.cup_player_level_projection_events`. The clone ceremony, running only against a
marker-guarded `phub_restore_*` database, creates the `eligibility` schema when absent under the
migrator identity, revokes broad PUBLIC/runtime schema/table privileges, grants only the matrix
privileges to the distinct runtime role, and verifies owners, FORCE RLS, exact tenant policies,
grant options, PUBLIC, third-party and column ACLs before committing the clone transaction. An
existing schema with the wrong owner or third-party grant fails closed instead of being rewritten.
The runtime role has only `USAGE` (never `CREATE`) on `eligibility` and `games`.

Before migration 0084 the ceremony inserts two synthetic tenants only into the disposable clone so
the migration seeds canonical PADEL levels and OFF policies. After 0087 and post-ACL attestation it
uses the real runtime repository to prove one authoritative projection apply, an identical replay,
event-ledger idempotency, an unmapped cross-tenant write refusal and zero cross-tenant visibility in
both projection relations. No phone, client ID, player ID or row payload is emitted. The fixed
allowlist adds two matrix metadata lines and these two aggregate evidence lines:

```text
eligibility_payment_acl matrix=eligibility-payment-cup-projection-acl-v2 pre=passed post=passed privileges=exact status=passed
cup_player_level_projection_clone_probe apply=passed replay=passed idempotency=passed cross_tenant_rls=passed status=passed
```

The final line includes `eligibility_payment=3 cup_projection=1`, and every
`authorizes*=false` boundary remains unchanged. The successful `33_V1` artifact is exactly 35 lines;
`29_V1` remains exactly 31 lines. The ceremony never targets the shared database, never changes a
shared release/runtime file, never deploys an application and never enables CUP ingress, eligibility
policy, roster guard or payment behavior. Installing the root-owned candidate artifacts and running
this manual workflow remain separately approved operations. A missing, changed or unverified
`/etc/phub/realtime.env` invalidates the metadata-only receipt and remains a hard preflight blocker;
the forced command cannot bypass it by reading or accepting the secret file directly.

### Exact 34-file participation-command clone rehearsal contract

`COMMUNITIES_STAGED_REHEARSAL_34_V1` and
`REHEARSE_COMMUNITIES_STAGING_34_V1` are a new clone-only contract. They preserve the frozen
`29_V1`, `32_V1`, and `33_V1` contracts and append
`0088_participation_command_foundation.sql` as the sixth `participation_command` phase. The ordered
34-file pending-set SHA-256 is
`488d3c7a9494b3c4587b2e849f937fe161ce3a9c7c7e336e63188cfaafdedc98`.

The phase binding uses `eligibility-payment-participation-command-acl-v3` at SHA-256
`482afdc666acb2caa268c66b46575614acf10807727ca9e6a086eb805b38ca6e`. It adds only
`SELECT, INSERT, UPDATE` for `eligibility.activity_level_projections` and
`eligibility.participation_commands`; v1 and v2 digests remain unchanged. Pre/post catalog checks
still require migrator ownership, FORCE RLS, exact tenant policies, no PUBLIC/third-party/column
grants, and runtime schema `USAGE` without `CREATE`.

After the existing CUP projection probe, the disposable-clone runtime probe creates two canonical
activity constraints, authorizes an in-range command with a payment snapshot, proves exact replay
and idempotency-key conflict, persists an out-of-range rejection, acknowledges the authorized writer
result, and proves cross-tenant invisibility. It emits only aggregate fixed text:

```text
participation_command_clone_probe authorize=passed deny=passed replay=passed idempotency=passed payment_snapshot=passed acknowledgement=passed cross_tenant_rls=passed status=passed
```

The final line includes `participation_command=1` and `participation_probe=passed`; successful v34
evidence is exactly 36 lines. The `authorizes*=false` boundary remains unchanged. This contract does
not apply migration 0088 to staging, deploy an application, configure a server token, enable the API
or expiry worker, route any writer, start a booking/payment, or enable `SHADOW`, `WARN`, or `BLOCK`.

## Activation boundary

Merging the code and forward migrations does not authorize import or activation. Keep
`COMMUNITIES_READ_MODE=legacy`, `communityCanonical=false`, media/invite/realtime flags false, and
the canonical worker/realtime consumers stopped. Import, identity binding, ownership, Media/S3,
Realtime and write activation each require separate evidence and approval.
