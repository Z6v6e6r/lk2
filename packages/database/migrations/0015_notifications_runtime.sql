-- Runtime state for the first in-app notification slice. All delivery gates default to off.

create table if not exists notifications.tenant_runtime_settings (
  tenant_id uuid primary key references identity.tenants(id),
  in_app_enabled boolean not null default false,
  web_push_enabled boolean not null default false,
  ios_push_enabled boolean not null default false,
  android_push_enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id)
);

create table if not exists notifications.user_read_state (
  tenant_id uuid not null,
  user_id uuid not null,
  read_through_created_at timestamptz,
  read_through_item_id uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, read_through_item_id)
    references notifications.inbox_items(tenant_id, id),
  check (
    (read_through_created_at is null and read_through_item_id is null)
    or (read_through_created_at is not null and read_through_item_id is not null)
  )
);

create table if not exists notifications.read_cursor_commands (
  tenant_id uuid not null,
  user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  through_item_id uuid not null,
  result_cursor_created_at timestamptz not null,
  result_cursor_item_id uuid not null,
  changed_count integer not null default 0 check (changed_count >= 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, idempotency_key),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, through_item_id)
    references notifications.inbox_items(tenant_id, id),
  foreign key (tenant_id, result_cursor_item_id)
    references notifications.inbox_items(tenant_id, id)
);

alter table notifications.tenant_runtime_settings enable row level security;
alter table notifications.user_read_state enable row level security;
alter table notifications.read_cursor_commands enable row level security;

create policy notification_runtime_settings_tenant_isolation
  on notifications.tenant_runtime_settings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy notification_user_read_state_tenant_isolation
  on notifications.user_read_state
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy notification_read_cursor_commands_tenant_isolation
  on notifications.read_cursor_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.tenant_runtime_settings force row level security;
alter table notifications.user_read_state force row level security;
alter table notifications.read_cursor_commands force row level security;
