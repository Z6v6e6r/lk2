-- phub:reviewed-blocking-index
--
-- Non-concurrent index reviewed as low-risk rather than blocking:
--   * the table holds 417 rows in the beta contour and 109 in the only deployed production contour,
--     so the build is effectively instantaneous and cannot block meaningful traffic;
--   * the change is a net reduction in index count (the non-unique lookup index is replaced by the
--     unique equivalent under the same name and predicate);
--   * an index is reversible (drop index) unlike a destructive change.
--
-- Expand-only: make the tenant-scoped phone lookup unambiguous.
--
-- A phone in `profile.user_summaries.phone_e164` is a phone that a phone login verified, and it is
-- the strongest of the two phone claims the CUP resolver reads. Both the login path and the CUP
-- recipient resolver already refuse to guess when one phone matches more than one user: the login
-- repository returns no account (`apps/api/src/auth/postgres-auth-repository.ts`, the
-- `result.rows.length !== 1` guard) and the resolver reports the phone as unresolved
-- (`packages/database/src/admin-notification-repository.ts`). A duplicate therefore silently makes a
-- person unreachable by phone — which is exactly what happened in the beta contour, where the
-- verified phone and the person's active Web Push subscriptions ended up on two accounts. This index
-- turns that runtime refusal into a schema guarantee.
--
-- The guard below fails the migration with an actionable count when any tenant still holds duplicate
-- non-null phones, so the failure happens before the index build and reports how many tenants and how
-- many phone pairs are affected instead of surfacing a bare "could not create unique index". Phone
-- values themselves are never printed: the operator resolves them with
-- `npm run identity:phone-anomalies:report`.
--
-- Rollback: the previous definition is
-- `create index if not exists user_summaries_phone_lookup_idx on profile.user_summaries
-- (tenant_id, phone_e164) where phone_e164 is not null` (0017_admin_notification_campaigns.sql), so a
-- manual revert is a drop plus that statement. Two cautions: the migration stays recorded in
-- `schema_migrations`, so a manual revert is silent drift that a later `db:migrate` will not correct;
-- and renaming an already-applied file trips MIGRATION_LEDGER_UNKNOWN and blocks every later
-- migration on that contour.
--
-- The previous index (`user_summaries_phone_lookup_idx`) was a non-unique partial index on the same
-- columns, so lookups keep using the same index and the change is backward compatible for existing
-- rows. NOT VALID is deliberately avoided: the table is small, so a validated build is cheap, and a
-- validated index is what actually protects the data.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  duplicate_tenants integer;
  duplicate_pairs integer;
begin
  select count(distinct tenant_id), count(*)
    into duplicate_tenants, duplicate_pairs
    from (
      select tenant_id
        from profile.user_summaries
       where phone_e164 is not null
       group by tenant_id, phone_e164
      having count(*) > 1
    ) duplicated;

  if duplicate_pairs > 0 then
    raise exception
      'verified_phone_duplicate: % tenant(s) hold % verified phone(s) claimed by more than one account; run identity:phone-anomalies:report and resolve them before this migration',
      duplicate_tenants,
      duplicate_pairs;
  end if;
end
$$;

drop index if exists profile.user_summaries_phone_lookup_idx;

create unique index if not exists user_summaries_phone_lookup_idx
  on profile.user_summaries (tenant_id, phone_e164)
  where phone_e164 is not null;
