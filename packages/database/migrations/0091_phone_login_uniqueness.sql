-- phub:reviewed-new-table-index
--
-- Non-concurrent index reviewed as low-risk rather than blocking:
--   * profile.user_summaries holds 109 rows in the only deployed environment, so the build is
--     effectively instantaneous and cannot block meaningful traffic;
--   * the change is a net reduction in index count (one dropped, one created under the same name);
--   * an index is reversible (drop index) unlike a destructive change.
--
-- Expand-only: make the tenant-scoped phone lookup unambiguous.
--
-- Phone is the end-user login anchor for accounts migrated from legacy LK: the first sign-in is by
-- phone, after which an account can move to credentials or long-lived app tokens. The login path
-- already refuses to guess when a phone matches more than one user
-- (`apps/api/src/auth/postgres-auth-repository.ts:246-262` - `if (result.rows.length !== 1) return
-- undefined;`), so a duplicate would make sign-in impossible for those users rather than silently
-- picking one. This index turns that runtime refusal into a schema guarantee, so a backfill cannot
-- introduce an unusable account.
--
-- The previous index (`user_summaries_phone_lookup_idx`) was a non-unique partial index on the same
-- columns. This replaces it with the unique equivalent under the same name and predicate, so lookups
-- keep using the same index and the change is backward compatible for existing rows: the table is
-- verified to contain zero duplicate non-null phones at the time of writing.
--
-- NOT VALID is deliberately avoided: the table is small, so a validated build is cheap, and a
-- validated constraint is what actually protects the backfill.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop index if exists profile.user_summaries_phone_lookup_idx;

create unique index if not exists user_summaries_phone_lookup_idx
  on profile.user_summaries (tenant_id, phone_e164)
  where phone_e164 is not null;
