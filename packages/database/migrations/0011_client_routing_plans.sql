-- Expand-only, tenant-scoped transport plan used during the Viva-to-PadlHub migration.
-- The plan never contains credentials and defaults every tenant to PadlHub-only transport.

create table integration.client_routing_plans (
  tenant_id uuid primary key references identity.tenants(id),
  mode text not null check (mode in ('PADLHUB_ONLY', 'MIXED_END_USER_READS')),
  revision bigint not null default 1 check (revision > 0),
  valid_for_seconds integer not null default 60 check (valid_for_seconds between 30 and 300),
  changed_by uuid,
  change_reason text not null default 'INITIAL_SAFE_DEFAULT'
    check (char_length(btrim(change_reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into integration.client_routing_plans (tenant_id, mode)
select id, 'PADLHUB_ONLY'
from identity.tenants
on conflict (tenant_id) do nothing;

alter table integration.client_routing_plans enable row level security;

create policy client_routing_plans_tenant_isolation
  on integration.client_routing_plans
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.client_routing_plans force row level security;

create table integration.client_routing_plan_commands (
  tenant_id uuid not null references identity.tenants(id),
  idempotency_key text not null
    check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (char_length(request_hash) = 64),
  requested_mode text not null
    check (requested_mode in ('PADLHUB_ONLY', 'MIXED_END_USER_READS')),
  result_revision bigint not null check (result_revision > 0),
  actor_id uuid not null,
  correlation_id text not null check (char_length(correlation_id) between 16 and 128),
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

alter table integration.client_routing_plan_commands enable row level security;

create policy client_routing_plan_commands_tenant_isolation
  on integration.client_routing_plan_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.client_routing_plan_commands force row level security;
