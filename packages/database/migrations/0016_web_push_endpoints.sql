-- Expand-only runtime support for stable Web Push installations and idempotent endpoint commands.

alter table integration.notification_endpoints
  add column if not exists installation_id uuid;

create unique index if not exists notification_endpoints_installation_unique_idx
  on integration.notification_endpoints (
    tenant_id, user_id, provider_account_id, installation_id
  )
  where installation_id is not null;

create index if not exists notification_endpoints_active_user_idx
  on integration.notification_endpoints (
    tenant_id, user_id, provider_account_id, updated_at desc
  )
  where status = 'ACTIVE';

create table if not exists integration.notification_endpoint_commands (
  tenant_id uuid not null,
  user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type in ('REGISTER', 'REVOKE')),
  installation_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  endpoint_id uuid,
  result_status text not null default 'PENDING'
    check (result_status in ('PENDING', 'ACTIVE', 'REVOKED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, user_id, idempotency_key),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, endpoint_id)
    references integration.notification_endpoints(tenant_id, id),
  check (
    (result_status = 'PENDING' and completed_at is null and endpoint_id is null)
    or (result_status in ('ACTIVE', 'REVOKED') and completed_at is not null and endpoint_id is not null)
  )
);

alter table integration.notification_endpoint_commands enable row level security;

create policy notification_endpoint_commands_tenant_isolation
  on integration.notification_endpoint_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.notification_endpoint_commands force row level security;
