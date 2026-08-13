-- Expand-only runtime state and idempotency records for the first direct-chat slice.
-- Every gate defaults to off; applying this migration does not expose messaging routes.

create table if not exists messaging.tenant_runtime_settings (
  tenant_id uuid primary key references identity.tenants(id),
  http_enabled boolean not null default false,
  direct_enabled boolean not null default false,
  realtime_enabled boolean not null default false,
  contextual_enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id)
);

create table if not exists messaging.direct_conversation_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  other_user_id uuid not null,
  conversation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, other_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id),
  check (actor_user_id <> other_user_id)
);

create table if not exists messaging.read_cursor_commands (
  tenant_id uuid not null,
  user_id uuid not null,
  conversation_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  through_sequence bigint not null check (through_sequence >= 0),
  result_sequence bigint not null check (result_sequence >= 0),
  changed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, conversation_id, idempotency_key),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id)
);

create index if not exists direct_conversation_commands_conversation_idx
  on messaging.direct_conversation_commands (tenant_id, conversation_id);

create index if not exists read_cursor_commands_conversation_idx
  on messaging.read_cursor_commands (tenant_id, conversation_id, user_id);

alter table messaging.tenant_runtime_settings enable row level security;
alter table messaging.direct_conversation_commands enable row level security;
alter table messaging.read_cursor_commands enable row level security;

create policy messaging_runtime_settings_tenant_isolation
  on messaging.tenant_runtime_settings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy direct_conversation_commands_tenant_isolation
  on messaging.direct_conversation_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy messaging_read_cursor_commands_tenant_isolation
  on messaging.read_cursor_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table messaging.tenant_runtime_settings force row level security;
alter table messaging.direct_conversation_commands force row level security;
alter table messaging.read_cursor_commands force row level security;
