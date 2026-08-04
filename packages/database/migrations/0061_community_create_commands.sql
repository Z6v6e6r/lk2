-- Expand-only support for canonical community creation. Legacy OPEN/CLOSED rows
-- remain valid during migration; new commands write only the v2 visibility values.

alter table communities.communities
  add column if not exists revision bigint not null default 0
    check (revision >= 0),
  add column if not exists publishing_preset text;

alter table communities.communities
  add constraint communities_visibility_v2_check
    check (visibility in ('OPEN', 'CLOSED', 'PUBLIC', 'LISTED_PRIVATE', 'HIDDEN')) not valid,
  add constraint communities_publishing_preset_check
    check (
      publishing_preset is null
      or publishing_preset in ('OPEN_COMMUNITY', 'STAFF_FEED', 'MODERATED_FEED')
    ) not valid,
  add constraint communities_canonical_description_check
    check (
      publishing_preset is null
      or description is null
      or char_length(description) <= 2000
    ) not valid;

alter table communities.communities
  validate constraint communities_visibility_v2_check;

alter table communities.communities
  validate constraint communities_publishing_preset_check;

alter table communities.communities
  validate constraint communities_canonical_description_check;

alter table communities.communities
  drop constraint if exists communities_visibility_check;

create index if not exists community_active_owners_by_user_idx
  on communities.memberships (tenant_id, user_id, community_id)
  where role = 'OWNER' and status = 'ACTIVE';

create table if not exists communities.create_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  quota_override boolean not null default false,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create index if not exists community_create_commands_daily_quota_idx
  on communities.create_commands (tenant_id, actor_user_id, created_at desc);

alter table communities.create_commands enable row level security;

create policy community_create_commands_tenant_isolation
  on communities.create_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.create_commands force row level security;
