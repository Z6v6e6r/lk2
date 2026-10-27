-- Expand-only durable receipt for authenticated phone-to-subject linking.
-- Runtime activation and role privileges remain separate, default-off operations.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table identity.external_subject_link_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  actor_user_id uuid not null,
  session_family_id uuid not null,
  challenge_id uuid not null,
  purpose text not null default 'SUBJECT_LINK' check (purpose = 'SUBJECT_LINK'),
  audience text not null check (audience = 'client'),
  command_key_hash text not null check (command_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  outcome text check (outcome in ('LINKED', 'UNCHANGED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  unique (tenant_id, command_key_hash),
  unique (tenant_id, challenge_id),
  unique (tenant_id, id),
  check ((outcome is null) = (completed_at is null))
);

-- phub:reviewed-new-table-index -- empty additive receipt table at creation.
create index external_subject_link_commands_actor_time_idx
  on identity.external_subject_link_commands (tenant_id, actor_user_id, created_at desc);

alter table identity.external_subject_link_commands enable row level security;
alter table identity.external_subject_link_commands force row level security;
create policy external_subject_link_commands_tenant_isolation
  on identity.external_subject_link_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
