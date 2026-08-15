-- Tenant-local directed direct-message blocks. Existing messages and conversations are retained.
-- phub:reviewed-new-table-index

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table messaging.user_blocks (
  tenant_id uuid not null references identity.tenants(id),
  blocker_user_id uuid not null,
  blocked_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, blocker_user_id, blocked_user_id),
  foreign key (tenant_id, blocker_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, blocked_user_id) references identity.users(tenant_id, id),
  check (blocker_user_id <> blocked_user_id)
);

create table messaging.user_block_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  other_user_id uuid not null,
  action text not null check (action in ('BLOCK', 'UNBLOCK')),
  changed boolean not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, other_user_id) references identity.users(tenant_id, id),
  check (actor_user_id <> other_user_id)
);

create index user_blocks_reverse_pair_idx
  on messaging.user_blocks (tenant_id, blocked_user_id, blocker_user_id);

alter table messaging.user_blocks enable row level security;
alter table messaging.user_block_commands enable row level security;

create policy messaging_user_blocks_tenant_isolation
  on messaging.user_blocks
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy messaging_user_block_commands_tenant_isolation
  on messaging.user_block_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table messaging.user_blocks force row level security;
alter table messaging.user_block_commands force row level security;
