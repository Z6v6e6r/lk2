# Location-photo ACL baseline normalization

This is an R4 source building block, not an execution request or live authority. It closes two
observed schema-ACL prerequisites of the immutable 0102 photo profile. It does not change that
profile, its migrator, its bootstrap/cleanup scripts, or its migration ledger/catalog guards.

## Exact target and delta

The target is database `phub_beta`, system identifier `7679125609183186977`, with the exact 105-row
ledger ending at `0101_notification_lifecycle_channels.sql` and ledger digest
`7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd`. The photo relation must be absent.
The operator is the current database owner/superuser `phub_beta`, with no SET ROLE/session switch.

The forward SQL makes exactly two changes in one transaction:

```sql
grant usage on schema locations to phub_migrator;
revoke create on schema public from phub_migrator restrict;
```

It compares the complete normalized owner/ACL of both schemas before and after. `locations` adds
only a non-grantable USAGE entry issued by `phub_beta`; `public` removes only the non-grantable
CREATE entry issued by its owner `pg_database_owner`. Existing public USAGE remains. Canonical
comparison avoids treating ACL-array order as a permission change.

Both scripts take advisory lock 7140221 without waiting, use a 2-second lock timeout and a
15-second statement timeout, refuse enabled DDL event triggers and conflicting/long transactions,
and check non-superuser/non-bypass runtime and migrator roles without memberships. A before/after
metadata comparison preserves all unrelated schema ACLs, relation/column/default ACLs, relation
owners/RLS and the target roles/memberships. No rows, executable migrations, owners, default ACLs,
relation/column ACLs or role attributes are changed.

## Required admission before any apply

A controlled one-attempt packet still has to be prepared and independently reviewed. These SQL
files alone are not that packet. Do not invoke them manually or use the ordinary all-pending
migrator. Before requesting exact ACL authority, the packet must:

1. Bind reviewed commit/tree, both SQL digests, successful exact-head CI and disposable PG16 proof.
2. Bind a fixed operation ID, canonical UTC expiry and explicit confirmation, target database/system
   identifier, exact operator, and the complete current ACL/role/ledger preimage. Preserve raw ACL
   hashes as well as normalized ACL hashes in root-owned 0600, no-symlink, single-link evidence.
3. Re-read all four installed API/Web/Worker/Realtime container IDs, immutable image references,
   release labels, health and restart counts. The observation used to prepare this source was
   release `2bf56ca8c1bc3e27db5c857dbf961ad400f2294b-40344026107-1`; an observation is not a permanent
   authority. Stop if the sealed runtime snapshot changes or another migration/provision owner
   holds custody. No container or runtime-secret mutation belongs to this operation.
4. Prepare and review a guard-only, read-only transaction containing every pre-effect assertion
   and ROLLBACK. It must execute neither ACL statement; post-effect assertions belong to the
   disposable rehearsal. This check does not replace a fresh preimage at apply time.
5. Durably publish the request/preimage and an admitted intent before launching exactly one psql
   subprocess with ON_ERROR_STOP. Preserve its bounded exit/ACK and postcheck evidence before
   releasing custody. No automatic retry or automatic inverse is allowed.

The disposable test rewrites a copy of the fixed SQL only inside an explicitly guarded Actions
PostgreSQL service, using a random owned database and roles. There is no production bypass flag.
It checks public grantor semantics, the two-change postimage, unchanged unrelated ACLs, lock and
preimage negatives, one-shot rejection, recovery, and exact return to the original ACL.

## Backup and ambiguous outcomes

For this two-ACL transaction, the durable complete metadata preimage and exact guarded inverse are
the recovery backup. There is no row/schema-owner change to restore. A fresh full database backup
using the existing photo backup/isolated-restore machinery is required **after normalization and
before migration 0102**. Do not weaken the existing photo backup's normalized-state precondition.
If scope expands beyond these two ACL changes or exact inverse recovery cannot be proved, stop and
prepare the broader backup/recovery operation before applying anything.

After a lost ACK, do not rerun SQL. Perform only a fresh read-only reconciliation against the sealed
request, original preimage, target/runtime identities, roles, ledger and complete schema ACLs:

- Exact PRE with unchanged unrelated metadata: no committed effect observed; record ABORTED. A new
  attempt requires a new explicit authority and operation identity.
- Exact POST with unchanged unrelated metadata: record APPLIED/reconciled without replay.
- Any third/mixed state or foreign owner: record UNKNOWN and retain custody for the owner.

The transaction cannot commit a half-delta by itself. A third state indicates drift or insufficient
evidence, not permission to repair it automatically.

## Guarded recovery

The inverse requires separate authority and the exact normalized postimage, the same 105-row
ledger and an absent photo relation. It is forbidden once migration 0102 starts or applies. It
reverses only the two ACL changes, preserving everything else:

```sql
revoke usage on schema locations from phub_migrator restrict;
grant create on schema public to phub_migrator;
```

Re-read the complete original ACL, including `pg_database_owner` grantor semantics. Once 0102 is
admitted, normalization is the intended durable baseline and the immutable photo cleanup preserves
it. Never restore the pre-normalization ACL as an automatic migration rollback.

No deployment, SQL execution, grant, revoke, migration or runtime activation is authorized by this
source document. CI/synthetic checks are source evidence; actual admission/apply/restore receipts
and separate live approvals remain required.

## Execution packet

`scripts/control-timeweb-location-photo-acl.py` is the reviewed one-attempt packet for the two ACL
changes above. It runs as root from the enrolled controller checkout with one mode argument and the
fixed request `/opt/phub/timeweb-beta/operator/location-photo-acl-normalize.json` (root-owned 0600,
single link, secure parent chain). Prepare/execute/reconcile serialize on a kernel advisory lock
(`flock`) over a root-owned 0600 lock file that is intentionally never deleted; the kernel releases
it on process exit, so a crashed invocation never wedges `--reconcile`, and a concurrent invocation
fails closed with `LOCATION_PHOTO_ACL_PACKET_BUSY` (no manual lock removal is needed):

- `--prepare <request>` validates the request against schema
  `PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_V1`, target database/system identifier, enrolled
  controller `HEAD`/tree/config/Clean full clone, the pinned forward/recover SQL digests, the 105-row
  ledger digest `7bd04764…`, the disposable PG16 proof digest and a 20-60 minute expiry. It captures
  a canonical read-only preimage (ledger, both schema ACLs, unrelated schema/relation/column/default
  metadata, target roles/memberships, event triggers, lock/transaction hazards, photo absence, four
  installed API/Web/Worker/Realtime container readbacks and the installed envelope), writes
  `operator/location-photo-acl-normalize.preimage.json`, derives a **guard-only** SQL from the
  reviewed forward file (all pre-effect assertions, no ACL statement, ending in `rollback;`), executes
  exactly one read-only `psql` over local stdin inside the postgres container, and writes the guard
  log and `operator/location-photo-acl-normalize.intent.json`. The confirmation is
  `NORMALIZE_LOCATION_PHOTO_ACL_105_TWO_SCHEMA_GRANTS_KEEP_EDITOR_ACL_NO_MIGRATION`.
- `--execute <request>` re-validates request/intent/preimage and custody, requires the current
  readbacks to equal the sealed preimage, then runs exactly one `psql` subprocess with the unmodified
  forward SQL on stdin (`ON_ERROR_STOP=1`, no retry). On success it verifies the canonical POST ACL,
  the unchanged unrelated metadata, the unchanged 105-row ledger and photo absence, writes the
  `APPLIED_VERIFIED` receipt plus a root-only retirement marker, and refuses a second apply for the
  same operation ID. A failed or ambiguous acknowledgement is classified read-only as `ABORTED`
  (exact PRE), `APPLIED_RECONCILED` (exact POST) or `UNKNOWN` (anything else) — no automatic inverse.
- `--reconcile <request>` is read-only classification only; it records the same statuses and never
  executes the forward SQL.

The packet does not edit, weaken or bypass the reviewed SQL, and it grants no migration, deploy or
inverse authority by itself: a sealed request, a separate live approval and the exact-target
operation owner remain required.
