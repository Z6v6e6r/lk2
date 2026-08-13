-- Idempotency journal for explicit, tenant-scoped booking notification ruleset provisioning.
-- This migration intentionally does not seed templates/rules or enable any runtime transport.

create table if not exists notifications.ruleset_provision_commands (
  tenant_id uuid not null references identity.tenants(id),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  ruleset_version text not null check (ruleset_version ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id)
);

alter table notifications.ruleset_provision_commands enable row level security;

create policy notification_ruleset_provision_commands_tenant_isolation
  on notifications.ruleset_provision_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.ruleset_provision_commands force row level security;
