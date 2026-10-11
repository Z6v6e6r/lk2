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

Migration `0098_location_recommendation_photos.sql` is additive and has no backfill. Applying it,
granting runtime access and promoting the API are separate authorized transitions. Do not promote
the new API until the exact table ACL and tenant probes below pass. Existing generic role-boundary
checks do not cover the `locations` schema.

Before DDL, verify the backup/restore evidence, the packaged migration checksum against the ledger,
parent-table counts and conflicting locks/long transactions. Use separate verified runtime and
migrator connections to the same database/system identifier. Require distinct roles with
`session_user = current_user`; runtime must be nonowner, `NOSUPERUSER`, `NOBYPASSRLS`, and unable to
assume the migrator. Migrator needs bounded `CREATE` on `locations`. Runtime must already have
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

Application rollback retains migration 0098 and all bindings. Roll back the immutable API/client
images; do not drop the table or delete photos. Production migration, grant, publication and photo
activation require their exact target authority and are not established by source or CI checks.
