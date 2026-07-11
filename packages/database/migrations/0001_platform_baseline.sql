create extension if not exists pgcrypto;

create schema if not exists identity;
create schema if not exists profile;
create schema if not exists catalog;
create schema if not exists schedule;
create schema if not exists booking;
create schema if not exists commerce;
create schema if not exists games;
create schema if not exists tournaments;
create schema if not exists community;
create schema if not exists messaging;
create schema if not exists notifications;
create schema if not exists integration;
create schema if not exists audit;

create table if not exists identity.tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration.external_entity_map (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  external_system text not null,
  entity_type text not null,
  internal_id uuid not null,
  external_id text not null,
  external_version text,
  last_synced_at timestamptz,
  sync_status text not null default 'pending',
  sync_error_code text,
  unique (tenant_id, external_system, entity_type, external_id),
  unique (tenant_id, external_system, entity_type, internal_id)
);

create table if not exists integration.domain_ownership (
  tenant_id uuid not null references identity.tenants(id),
  domain_name text not null,
  ownership_mode text not null check (
    ownership_mode in ('VIVA_PRIMARY', 'SHADOW_COMPARE', 'LOCAL_PRIMARY', 'LOCAL_ONLY')
  ),
  changed_at timestamptz not null default now(),
  changed_by uuid,
  rollback_mode text check (
    rollback_mode is null or
    rollback_mode in ('VIVA_PRIMARY', 'SHADOW_COMPARE', 'LOCAL_PRIMARY', 'LOCAL_ONLY')
  ),
  primary key (tenant_id, domain_name)
);

create table if not exists audit.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  event_type text not null,
  aggregate_id uuid not null,
  correlation_id text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  publish_attempts integer not null default 0
);

create index if not exists outbox_unpublished_idx
  on audit.outbox_events (occurred_at)
  where published_at is null;

create table if not exists audit.inbox_events (
  consumer_name text not null,
  event_id uuid not null,
  tenant_id uuid not null references identity.tenants(id),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (consumer_name, event_id)
);

create table if not exists audit.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  actor_id uuid,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  result text not null,
  reason text,
  correlation_id text not null,
  old_value jsonb,
  new_value jsonb,
  occurred_at timestamptz not null default now()
);

alter table integration.external_entity_map enable row level security;
alter table integration.domain_ownership enable row level security;
alter table audit.outbox_events enable row level security;
alter table audit.inbox_events enable row level security;
alter table audit.audit_log enable row level security;

create policy external_entity_map_tenant_isolation on integration.external_entity_map
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy domain_ownership_tenant_isolation on integration.domain_ownership
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy outbox_events_tenant_isolation on audit.outbox_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy inbox_events_tenant_isolation on audit.inbox_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy audit_log_tenant_isolation on audit.audit_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

insert into identity.tenants (tenant_key, display_name)
values ('local-padel', 'Local Padel')
on conflict (tenant_key) do nothing;
