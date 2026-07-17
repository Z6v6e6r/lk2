-- Expand-only canonical foundation for PadlHub communities. The temporary LK legacy
-- read bridge maps identifiers into integration.external_entity_map but does not dual-write
-- business state into these tables.

create schema if not exists communities;

create table communities.communities (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text check (description is null or char_length(description) <= 4000),
  visibility text not null default 'OPEN' check (visibility in ('OPEN', 'CLOSED')),
  join_policy text not null default 'INSTANT'
    check (join_policy in ('INSTANT', 'MODERATED', 'INVITE_ONLY')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  is_verified boolean not null default false,
  logo_object_key text check (
    logo_object_key is null
    or (char_length(logo_object_key) between 1 and 1024 and logo_object_key !~ '^[a-z]+://')
  ),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id),
  check (
    (status = 'ACTIVE' and archived_at is null)
    or (status = 'ARCHIVED' and archived_at is not null)
  )
);

create table communities.memberships (
  tenant_id uuid not null,
  community_id uuid not null,
  user_id uuid not null,
  role text not null default 'MEMBER'
    check (role in ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER')),
  status text not null default 'ACTIVE'
    check (status in ('PENDING', 'ACTIVE', 'LEFT', 'REMOVED', 'BANNED')),
  pinned_at timestamptz,
  requested_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id, user_id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (role <> 'OWNER' or status = 'ACTIVE'),
  check (status <> 'PENDING' or requested_at is not null),
  check (status <> 'ACTIVE' or joined_at is not null),
  check (status not in ('LEFT', 'REMOVED') or left_at is not null)
);

create unique index communities_one_active_owner_idx
  on communities.memberships (tenant_id, community_id)
  where role = 'OWNER' and status = 'ACTIVE';

create index communities_memberships_user_idx
  on communities.memberships (tenant_id, user_id, status, pinned_at desc, updated_at desc);

create index communities_active_updated_idx
  on communities.communities (tenant_id, updated_at desc, id)
  where status = 'ACTIVE';

alter table communities.communities enable row level security;
alter table communities.memberships enable row level security;

create policy communities_tenant_isolation on communities.communities
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_memberships_tenant_isolation on communities.memberships
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.communities force row level security;
alter table communities.memberships force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'communities', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
