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
- `/usr/local/libexec/phub/verify-postgres-backup-restore.sh`.

The strengthened `29_V1` wire binding has 17 fields and its successful evidence has exactly 31
lines. It is intentionally fail-closed across a partial installation: an old 15-field caller is
rejected by the new wrapper, while an old wrapper rejects the new 17-field call before Docker,
backup or database access. Do not dispatch until all installed command SHA-256 values match the
same merged revision and the 17-field contract test has passed.

The dedicated key has only this forced command:

```text
restrict,command="env PHUB_REHEARSAL_BACKUP_ROOT=/var/lib/phub-preflight/backups /usr/local/libexec/phub/run-communities-staged-migration-rehearsal.sh" <rehearsal-public-key>
```

It must not be the inventory key, backup key or `STAGING_DEPLOY_KEY`, and it receives no shell,
forwarding, arbitrary Docker, shared migrator or deploy capability. The administrator separately
creates `/opt/phub/release.communities-rehearsal-<candidate-sha>.env` as root-owned mode 0400 or
0440 with exactly two lines: the reviewed `RELEASE` and `MIGRATOR_IMAGE_DIGEST`. Its SHA-256 is a
dispatch input. The command uses shared root-owned `release.env` only as the full interpolation
base, then applies this strict file as the final override. The administrator also installs the
reviewed `deploy/compose.staging.yaml` as root-owned
`/opt/phub/compose.communities-rehearsal-<candidate-sha>.yaml`; its SHA-256 is bound in the remote
command. The forced-command account may read these files and `/etc/phub/staging.env` plus
`/etc/phub/staging.migrator.env`, but may not modify them or any shared release/runtime file.

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

This is explicitly **not execution-ready**. No authoritative runtime ACL matrix exists for the
new `eligibility` and payment-evidence tables. The dispatch token
`REHEARSE_COMMUNITIES_STAGING_32_V1`, the forced command, the clone helper and the migrator request
policy deliberately fail closed before SSH, backup, clone, Docker, database-pool creation or DDL.
Do not guess grants or add them as a rehearsal shortcut. The versioned policy proves the intended
ordering; it is not an executable rehearsal path. A separately reviewed ACL matrix and a new
bounded authorization are required before enabling any 32_V1 execution path.

When that gate is separately implemented and approved, its fixed redacted evidence must contain
the contract version, pending-set SHA, one aggregate eligibility audit and one aggregate payment
evidence audit. The eligibility audit must prove exactly seven PADEL levels, three active OFF
policies and three all-false readiness rows per tenant; known-label/mappable-range backfill checks;
aggregate unknown, unmapped and reversed counts; and unchanged participant, reservation and
waitlist primary-key counts and digests. The payment audit must prove the expected table, FORCE
RLS, tenant policy, validated constraints and index, a nullable validated `provider_exercise_id`,
and zero fresh-chain evidence rows without emitting identifiers or other sensitive values. Its final
line must include `eligibility_payment=3`; every `authorizes*=false` boundary remains unchanged.

## Activation boundary

Merging the code and forward migrations does not authorize import or activation. Keep
`COMMUNITIES_READ_MODE=legacy`, `communityCanonical=false`, media/invite/realtime flags false, and
the canonical worker/realtime consumers stopped. Import, identity binding, ownership, Media/S3,
Realtime and write activation each require separate evidence and approval.
