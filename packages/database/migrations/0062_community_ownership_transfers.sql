-- Expand-only support for normal ownership transfer. Both membership changes,
-- the replay record, audit fact and outbox event are committed in one tenant transaction.

create table if not exists communities.ownership_transfer_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  target_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  expected_owner_revision bigint not null check (expected_owner_revision > 0),
  expected_target_revision bigint not null check (expected_target_revision > 0),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, target_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  check (actor_user_id <> target_user_id)
);

create index if not exists community_ownership_transfer_aggregate_idx
  on communities.ownership_transfer_commands (tenant_id, community_id, created_at desc);

alter table communities.ownership_transfer_commands enable row level security;

create policy community_ownership_transfer_commands_tenant_isolation
  on communities.ownership_transfer_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.ownership_transfer_commands force row level security;
