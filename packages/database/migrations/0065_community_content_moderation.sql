-- Expand-only canonical content moderation command and evidence tables.

create table if not exists community_content.moderation_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  action text not null check (action in (
    'APPROVE_POST', 'REJECT_POST', 'HIDE_POST', 'RESTORE_POST',
    'HIDE_COMMENT', 'RESTORE_COMMENT'
  )),
  target_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create table if not exists community_content.moderation_actions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  community_id uuid not null,
  actor_user_id uuid not null,
  target_type text not null check (target_type in ('POST', 'COMMENT')),
  target_id uuid not null,
  action text not null check (action in ('APPROVE', 'REJECT', 'HIDE', 'RESTORE')),
  previous_status text not null,
  resulting_status text not null,
  reason_code text check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  target_revision bigint not null check (target_revision > 0),
  correlation_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create index if not exists community_content_pending_moderation_queue_idx
  on community_content.posts (tenant_id, updated_at, id)
  where status = 'PENDING_MODERATION';

create index if not exists community_content_moderation_actions_target_idx
  on community_content.moderation_actions
    (tenant_id, community_id, target_type, target_id, created_at desc);

alter table community_content.moderation_commands enable row level security;
alter table community_content.moderation_actions enable row level security;

create policy community_content_moderation_commands_tenant_isolation
  on community_content.moderation_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_moderation_actions_tenant_isolation
  on community_content.moderation_actions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table community_content.moderation_commands force row level security;
alter table community_content.moderation_actions force row level security;
