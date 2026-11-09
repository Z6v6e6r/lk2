-- Expand-only cache of the last server-accepted Viva profile observation.
-- Ownership stays VIVA_PRIMARY: this row is not a PadlHub profile projection and never replaces
-- the complete Home dashboard aggregate. It exists only so the Android endpoint exception
-- (ADR-0023/0020, profile.read) can publish the level and balance that the device read itself
-- through a short-lived delegation. No provider identifier or token is stored here.
-- Rollback is the read-path flag: with PROFILE_NATIVE_READ_ENABLED off the GET /profile fallback
-- stops merging the row immediately; the row is overwritten by newer observations and kept until
-- the account is deleted, so rollback needs no destructive cleanup.
-- phub:reviewed-new-table-index
create table profile.provider_observations (
 tenant_id uuid not null references identity.tenants(id), user_id uuid not null,
 level_label text check(level_label is null or level_label in ('D','D+','C','C+','B','B+','A')),
 level_value numeric(8,5) check(level_value is null or (level_value>=0 and level_value<=10)),
 balance_minor bigint,
 currency text not null default 'RUB' check(currency='RUB'),
 observed_at timestamptz not null,
 updated_at timestamptz not null default now(),
 primary key(tenant_id,user_id),
 foreign key(tenant_id,user_id) references identity.users(tenant_id,id),
 check((level_label is null)=(level_value is null))
);
alter table profile.provider_observations enable row level security;
alter table profile.provider_observations force row level security;
create policy provider_observation_tenant_isolation on profile.provider_observations
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
