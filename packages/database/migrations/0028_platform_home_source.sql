-- Expand-only producer state for Home components owned by canonical PadlHub domains.
-- Messaging is derived from conversation read cursors, navigation from server product
-- configuration and capabilities from tenant-scoped access profiles. Locations keep their
-- existing LOCAL_ONLY revision owner; the state row below only enables an initial fan-out.

create table integration.platform_home_source_components (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  component text not null check (component in ('messaging', 'navigation', 'capabilities')),
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

create index platform_home_source_due_idx
  on integration.platform_home_source_components (tenant_id, last_synced_at, user_id);

alter table integration.platform_home_source_components enable row level security;

create policy platform_home_source_components_tenant_isolation
  on integration.platform_home_source_components
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.platform_home_source_components force row level security;

insert into locations.home_projection_state (tenant_id, component_revision)
select id, 1 from identity.tenants
on conflict (tenant_id) do nothing;
