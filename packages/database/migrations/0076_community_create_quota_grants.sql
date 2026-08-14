-- Expand-only user-scoped, one-use quota grants for canonical community creation.
-- The User API never selects a grant. The create transaction discovers and consumes an eligible
-- grant only after the community and its OWNER membership have been written successfully.

create table if not exists communities.create_quota_grants (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  subject_user_id uuid not null,
  authorized_by_user_id uuid not null,
  capability text not null
    check (capability = 'communities.create.quota.override'),
  scopes text[] not null,
  reason_code text not null
    check (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ticket_id text not null
    check (ticket_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE', 'CONSUMED', 'EXPIRED')),
  revision bigint not null default 1 check (revision > 0),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_by_community_id uuid,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, subject_user_id, id),
  foreign key (tenant_id, subject_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, authorized_by_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, consumed_by_community_id)
    references communities.communities(tenant_id, id),
  check (
    scopes in (
      array['DAILY_CREATE_LIMIT']::text[],
      array['ACTIVE_OWNER_LIMIT']::text[],
      array['DAILY_CREATE_LIMIT', 'ACTIVE_OWNER_LIMIT']::text[],
      array['ACTIVE_OWNER_LIMIT', 'DAILY_CREATE_LIMIT']::text[]
    )
  ),
  check (expires_at = created_at + interval '24 hours'),
  check (
    (state = 'CONSUMED' and consumed_by_community_id is not null and consumed_at is not null)
    or (state <> 'CONSUMED' and consumed_by_community_id is null and consumed_at is null)
  )
);

create unique index if not exists community_create_quota_grants_one_active_user_idx
  on communities.create_quota_grants (tenant_id, subject_user_id)
  where state = 'ACTIVE';

create index if not exists community_create_quota_grants_expiry_idx
  on communities.create_quota_grants (tenant_id, expires_at, id)
  where state = 'ACTIVE';

create table if not exists communities.create_quota_grant_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  subject_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, subject_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, subject_user_id, grant_id)
    references communities.create_quota_grants(tenant_id, subject_user_id, id)
);

alter table communities.create_commands
  add column if not exists quota_grant_id uuid;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'community_create_commands_quota_grant_fk'
       and conrelid = 'communities.create_commands'::regclass
  ) then
    alter table communities.create_commands
      add constraint community_create_commands_quota_grant_fk
      foreign key (tenant_id, actor_user_id, quota_grant_id)
      references communities.create_quota_grants(tenant_id, subject_user_id, id) not valid;
  end if;
end
$$;

alter table communities.create_quota_grants enable row level security;
alter table communities.create_quota_grant_commands enable row level security;

create policy create_quota_grants_tenant_isolation
  on communities.create_quota_grants
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy create_quota_grant_commands_tenant_isolation
  on communities.create_quota_grant_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.create_quota_grants force row level security;
alter table communities.create_quota_grant_commands force row level security;
