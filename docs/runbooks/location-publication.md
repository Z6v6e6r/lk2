# Location publication runbook

## Preconditions

1. Confirm a verified database backup and rollback path.
2. Run `npm run db:migrate:check`, then apply migration `0021_location_profiles.sql` through the
   migrator. API processes must not run migrations on startup.
3. Confirm API and worker readiness and that `phub.locations-home-projector.v1` is consuming.
4. Grant only the required `locations.read`, `locations.manage` and, when separated operationally,
   `locations.publish` permissions through the audited access command.

## Publish

1. Open ЦУП → Настройки → Станции and create a draft.
2. Fill title, unique slug, city, court count, seven-day schedule, one HTTPS cover, amenities,
   address, coordinates, metro hint and E.164 phone.
3. Keep `Показывать на Главной` off until the detail page is approved. Save the draft and reload it
   to verify versioned persistence.
4. Publish only at 100% completeness. Verify the User API list and detail contain the PadlHub UUID,
   computed open status and no provider identifiers.
5. Enable Home visibility and set order. Verify the worker inbox/outbox event, the locations Home
   component revision and the next complete Home snapshot before approving the rollout.
6. Smoke the cabinet directory, detail card, navigation link and touch/mouse Home carousel.

## Failure and rollback

- On invalid content, archive the profile or return it to draft with a new versioned command.
- On Home projection failure, turn off `showOnHome`; the directory can remain published while the
  worker is repaired. Do not overlay a live row in the Home API.
- On API regression, roll back the immutable application image. Migration 0021 is expand-only and
  can remain in place; do not drop its tables during an incident.
- On duplicate slug or version conflict, reload the current profile and resolve explicitly. Never
  bypass the optimistic predicate or reuse an idempotency key with changed input.
- Record the correlation ID, PadlHub location UUID, profile version and Home snapshot revision in
  the incident or rollout log. Do not record phone values or image credentials.

## Recommendation photos: migration and runtime access

Migration `0102_location_recommendation_photos.sql` is additive and has no backfill. Applying it,
granting runtime access and promoting the API are separate authorized transitions. Do not promote
the new API until the exact table ACL and tenant probes below pass. Existing generic role-boundary
checks do not cover the `locations` schema.

Read the complete ledger first. If 0099–0101 are pending, use their dedicated reviewed notification
controller and target-bound release procedure before the photo expansion. The notification mode
accepts the exact packaged photo SQL but executes only 0099–0101, ending at ledger count 105 with
no photo table. Its frozen descriptor, golden catalogs and receipt checkpoints do not include 0102. Apply 0102 as a separate approved operation from that verified checkpoint, then retain its
own ledger/catalog evidence. Never substitute the legacy frozen 99→102 release or a generic
migrator invocation for the notification controller.

### Closed 105 → 106 controller package

The source controller is `PHUB_TIMEWEB_LOCATION_PHOTO_0102_MIGRATION_OPERATION_V1`. It deliberately
binds three independent identities:

- the installed API and Worker supplied in `expectedApi` and `expectedWorker` (the initial live
  baseline was b6bd6b38; never infer that 4256 was installed merely because its images exist);
- the published 4256 migrator manifest and the exact amd64 local image id pinned by
  `deploy/timeweb/location-photo-migration-0102.v1.json`;
- the current enrolled controller commit/tree and its fresh source-CI run.

The controller-source closure requires the complete reviewed package delta above (anchor
`2bf56ca8c1bc3e27db5c857dbf961ad400f2294b`) and admits further entries only when each extra path is
itself a reviewed controller file (`API_WORKER_CONTROLLER_FILES`) or one of the dedicated
`LOCATION_PHOTO_CONTROLLER_EXTRA_FILES` paths reviewed for this package
(`scripts/verify-source-ci.js`, `scripts/timeweb-join-dormant-profile.js`,
`scripts/timeweb-critical-web.js`, `scripts/timeweb-critical-web.test.ts`), with a plain
regular-blob `M`/`A` transition. This keeps an unrelated reviewed controller release (for example the
adoption-mode or ACL-baseline changes merged after the package was authored) from blocking the
migration while still rejecting foreign paths, duplicates, mode/type drift and a missing package
file. Package integrity is pinned independently by the
descriptor, migration and blob hashes.

Mint requests only from fresh readbacks. The package accepts exactly ledger count 105/digest
`7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd`, then expects count 106/digest
`ff74c193b5e5253f929818b1550d0e5c0264a9818cb0ee5437d49d5aa043904e` with 0102 checksum
`8817a4dab03e78d27023d4b3ee72a12bfa8f2ffe4599e4e78df1d3a3893366f0`. The migrator index digest
ends in `...6efce0b`; the local amd64 image id ends in `...425f50b48`. These are different OCI
identities and both must match.

Prefetch is a separate read-only image-store stage. Seal
`operator/location-photo-migrator-prefetch.json` with schema
`PHUB_TIMEWEB_LOCATION_PHOTO_0102_PREFETCH_V1`, the future migration operation, and confirmation
`PREFETCH_LOCATION_PHOTO_0102_MIGRATOR_KEEP_DATABASE_AND_RUNTIME`. Invoke the thin
`scripts/timeweb-location-photo-controller.js` entrypoint with
`--critical-location-photo-migrator-prefetch`; use its `-reconcile` variant only after an ambiguous
pull acknowledgement. The sealed receipt binds the request, installed runtime/secrets, ledger 105,
exact database preimage, retained local image inventory and the exact local migrator image id.
Copy that four-field prefetch binding into the later backup operation. A missing image resumes only
the original immutable digest; an already-present exact image after a lost acknowledgement is not
pulled again.

Before the migration request, create the existing-controller namespace backup operation
`PHUB_TIMEWEB_LOCATION_PHOTO_PRE0102_BACKUP_NAMESPACE_V1`. It uses
`backups/<controllerSha>-<controllerSourceCiRunId>-1-location-photo-pre0102`, preserves owners and
ACLs, restores into the existing networkless private namespace, and accepts the current editor ACL
instead of the historical owner-only notification preimage. A valid receipt must prove the same
source/restored ledger, exact target, owner/ACL security digest, role closure, isolated restore and
storage cleanup. A dump file or a normal `--no-owner --no-acl` restore is not equivalent evidence.

The migration controller then follows one closed sequence under the existing API/Worker executor
and active/provision locks:

1. Reattest installed runtime/secrets/Postgres, exact source/package/manifest/local image, fresh
   backup, ledger 105, empty target, editor ACL and role isolation. Database identity is fixed to
   `phub_beta` on system identifier `7679125609183186977`; self-consistent evidence for another
   database or cluster is not admissible.
2. Journal `BOOTSTRAP_INTENT`, run only `location-photo-role-bootstrap-0102.sql`, and prove the
   temporary migrator `CREATE` on `locations` and `public` plus column-scoped `REFERENCES` on
   `(tenant_id,id)` of `locations.profiles` and `locations.media_assets`. These are required by the
   immutable ordinary 4256 migrator and do not change editor or runtime rights.
3. Create the ordinary migrator container with `--pull never`, no arguments and the published 4256
   `apps/migrator` ordinary entrypoint, journal start intent, and wait for that same container. Do
   not use notification-only mode and do not create a second runner.
4. Prove ledger 106, exact empty table catalog/RLS/FKs/index/policy and no nonowner table ACL.
5. Journal `CLEANUP_INTENT`, run `location-photo-role-cleanup-0102.sql`, prove both temporary
   `CREATE` grants and all four column `REFERENCES` grants are absent (including a zero non-null
   parent-column ACL count), then seal success. Runtime photo rights remain a separate later
   authorization.

Use `--critical-location-photo-migrate` only after the backup receipt is fresh and pinned in the
migration plan. A returned `SUCCESS` deliberately retains the active/provision locks: immediately
run `--critical-location-photo-migrate-reconcile` with the same frozen request. Only the resulting
`RECONCILED/SUCCESS` receipt, after retained-probe and backup re-attestation, is terminal and
releases those locks. After any ambiguous controller exit, use only the reconcile mode; do not
invoke the deploy mode again.

There is one pre-effect exception: a host/process loss inside `prepare` before both
`preparation.json` and `plan.json` are durably present is `OWNER_DECISION`. The incomplete
transaction directory has no active/provision marker, container or database/ACL effect, but the
controller deliberately will not reconstruct missing preimage bytes or delete it automatically.
Inspect that exact directory read-only and use a separately authorized local-custody recovery;
never rerun deploy over the partial inventory. Once both files exist, a missing initial receipt is
reconcile-safe and is sealed `RECONCILED/ABORTED` without DDL.

An ambiguous bootstrap or cleanup acknowledgement is reconcile-only. At exact 105 with no table,
reconcile may remove the proven temporary `CREATE` and abort; it must not start DDL. At exact 106
with the original exited-zero container, reconcile may finish/prove cleanup and success; it must
not create or start another container. Any running container, table/ledger disagreement, checksum
drift, unexpected ACL, runtime drift or partial catalog is an owner decision, not an automatic
retry. Keep the canonical backup and controller capsule for recovery.

Before DDL, verify the backup/restore evidence, the packaged migration checksum against the ledger,
parent-table counts and conflicting locks/long transactions. Use separate verified runtime and
migrator connections to the same database/system identifier. Require distinct roles with
`session_user = current_user`; runtime must be nonowner, `NOSUPERUSER`, `NOBYPASSRLS`, and unable to
assume the migrator. The bounded transaction temporarily grants migrator `CREATE` on `locations`
and `public` and the four exact parent-column `REFERENCES` privileges; cleanup at either the clean
105 failure state or successful 106 state must revoke them before completion. This privilege scope
requires its own exact live-operation approval and is not covered by the earlier editor ACL grant.
Runtime must already have
`USAGE` on `locations` and `SELECT` on `locations.profiles` and `locations.media_assets`; stop if
those existing permissions are missing rather than widening them as part of this feature.

After migration, the owner/operator may perform only the separately approved grant for the exact
verified runtime role. In the owner-side `psql` session, set `runtime_role` to the role name already
verified through the separate runtime connection. Then execute this exact command and immediately
retain the catalog readback below. `:'runtime_role'` quotes the value as a SQL literal and PostgreSQL
`format('%I', ...)` quotes the identifier; never raw-interpolate a role into SQL.

```sql
\set ON_ERROR_STOP on
select pg_catalog.format(
  'grant select, insert, delete on table locations.recommendation_card_photos to %I', :'runtime_role'::text
) \gexec
```

No default ACL, role membership, grant option, or privileges on another table are part of this
step. Postcheck the table owner equals the verified migrator and differs from runtime; both RLS
flags must be true. Exactly one permissive `ALL` policy must apply to PUBLIC, with both USING and
WITH CHECK enforcing `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`.
Verify the two composite FK columns/targets in order, the tenant/location/type/asset primary key
and the tenant/location/type/active/order/asset read index.

```sql
select owner.rolname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c
join pg_catalog.pg_roles owner on owner.oid = c.relowner
where c.oid = 'locations.recommendation_card_photos'::regclass;

select case when a.grantee = 0 then 'PUBLIC' else r.rolname end as grantee,
       a.privilege_type, a.is_grantable
from pg_catalog.pg_class c
cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
left join pg_catalog.pg_roles r on r.oid = a.grantee
where c.oid = 'locations.recommendation_card_photos'::regclass
order by grantee, privilege_type;

select policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'locations' and tablename = 'recommendation_card_photos';
```

Except for owner privileges, the ACL must contain only runtime `SELECT`, `INSERT`, `DELETE`, all
without grant option; deny PUBLIC and unexpected grantees. On the runtime connection check
effective privileges as well, including inherited roles: no `UPDATE`, `REFERENCES`, `TRUNCATE` or
`TRIGGER`. The CI-only nonowner PostgreSQL test checks the bounded grant, RLS and FK failures on
synthetic disposable data. For an approved staging rehearsal, prove cross-tenant SELECT is empty,
cross-tenant writes fail with `42501`, and current-tenant inserts referencing a foreign asset or
missing station fail independently with `23503`; roll back all probe transactions.

Before activation verify media storage/readiness, then open ЦУП → Настройки → Станции → Фото
рекомендательных карточек. Upload into the required event type; new photos start inactive. Enable
the chosen photos and save/publish the station using its normal versioned command. Verify a fresh
first recommendation page uses the canonical station/type and the same photo remains across cursor
pages. Existing cursors retain their photo snapshot for five minutes. All inactive bindings use
the generic cover; clearing every binding restores the legacy cover fallback. Photo selection
requires an existing trusted station mapping for provider activities; names do not establish it.

The unreleased PR previously used `0098_location_recommendation_photos.sql`; that slot is now
occupied by support tickets in main. Only the photo migration is renumbered; already released
migration files and checksums are unchanged. Before a first apply, verify that neither the old
photo filename nor `0102_location_recommendation_photos.sql` is recorded as applied and that the
target table is absent. A repeated invocation must verify the matching 0102 ledger checksum and
the table catalog without running DDL again. If an old photo ledger entry, a checksum mismatch
or an unattested existing table is found, stop for explicit reconciliation; never delete ledger
rows, drop bindings or blindly run a renamed DDL.

Application rollback retains migration 0102 and all bindings. Roll back the immutable API/client
images; do not drop the table or delete photos. Production migration, grant, publication and photo
activation require their exact target authority and are not established by source or CI checks.
