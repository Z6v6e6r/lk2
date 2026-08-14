-- Expand-only one-time quota grants and community-scoped rolling quota evidence.

create table if not exists communities.direct_invite_quota_grants (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  community_id uuid not null,
  authorized_by_user_id uuid not null,
  capability text not null
    check (capability = 'communities.invite.quota.override'),
  reason_code text not null
    check (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ticket_id text not null
    check (ticket_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE', 'CONSUMED', 'EXPIRED')),
  revision bigint not null default 1 check (revision > 0),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_by_invite_id uuid,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, authorized_by_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, consumed_by_invite_id)
    references communities.direct_invites(tenant_id, id),
  check (expires_at = created_at + interval '24 hours'),
  check (
    (state = 'CONSUMED' and consumed_by_invite_id is not null and consumed_at is not null)
    or (state <> 'CONSUMED' and consumed_by_invite_id is null and consumed_at is null)
  )
);

create unique index if not exists community_direct_invite_quota_grants_one_active_idx
  on communities.direct_invite_quota_grants (tenant_id, community_id)
  where state = 'ACTIVE';

create index if not exists community_direct_invite_quota_grants_expiry_idx
  on communities.direct_invite_quota_grants (tenant_id, expires_at, id)
  where state = 'ACTIVE';

create table if not exists communities.direct_invite_quota_grant_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  community_id uuid not null,
  grant_id uuid not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, grant_id)
    references communities.direct_invite_quota_grants(tenant_id, id)
);

alter table communities.direct_invite_commands
  add column if not exists community_id uuid,
  add column if not exists quota_grant_id uuid;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'community_direct_invite_commands_community_fk'
       and conrelid = 'communities.direct_invite_commands'::regclass
  ) then
    alter table communities.direct_invite_commands
      add constraint community_direct_invite_commands_community_fk
      foreign key (tenant_id, community_id)
      references communities.communities(tenant_id, id) not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'community_direct_invite_commands_quota_grant_fk'
       and conrelid = 'communities.direct_invite_commands'::regclass
  ) then
    alter table communities.direct_invite_commands
      add constraint community_direct_invite_commands_quota_grant_fk
      foreign key (tenant_id, quota_grant_id)
      references communities.direct_invite_quota_grants(tenant_id, id) not valid;
  end if;
end
$$;

create index if not exists community_direct_invite_commands_issue_window_idx
  on communities.direct_invite_commands (tenant_id, community_id, created_at)
  where command_type = 'ISSUE' and community_id is not null;

-- Pre-0059 ISSUE rows have no community_id. Keep them in the rolling window via
-- the invite_id fallback until a separately verified backfill is complete.
create index if not exists community_direct_invite_commands_issue_legacy_window_idx
  on communities.direct_invite_commands (tenant_id, created_at, invite_id)
  where command_type = 'ISSUE' and community_id is null;

alter table communities.direct_invite_quota_grants enable row level security;
alter table communities.direct_invite_quota_grant_commands enable row level security;

create policy community_direct_invite_quota_grants_tenant_isolation
  on communities.direct_invite_quota_grants
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_direct_invite_quota_grant_commands_tenant_isolation
  on communities.direct_invite_quota_grant_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.direct_invite_quota_grants force row level security;
alter table communities.direct_invite_quota_grant_commands force row level security;
