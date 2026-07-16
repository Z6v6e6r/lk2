-- Expand-only producer state for server-side Viva Home synchronization.
-- External identifiers remain in integration.external_entity_map; only PadlHub UUID payloads
-- are committed here and emitted through the transactional outbox.

create table integration.viva_home_source_components (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  component text not null check (component in ('profile', 'upcoming', 'subscriptions')),
  source_revision bigint not null check (source_revision > 0),
  payload jsonb not null,
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  correlation_id text not null,
  fetched_at timestamptz not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, component),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (jsonb_typeof(payload) in ('object', 'array'))
);

create index viva_home_source_due_idx
  on integration.viva_home_source_components (tenant_id, last_synced_at, user_id);

alter table integration.viva_home_source_components enable row level security;

create policy viva_home_source_components_tenant_isolation
  on integration.viva_home_source_components
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.viva_home_source_components force row level security;
