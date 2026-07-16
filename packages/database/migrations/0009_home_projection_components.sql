-- Expand-only inbox state for the event-driven Home projection builder.
-- Domain owners publish normalized components; the worker assembles the public snapshot.

create table home.dashboard_components (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  component text not null check (
    component in (
      'profile',
      'messaging',
      'upcoming',
      'subscriptions',
      'communities',
      'promotion',
      'locations',
      'navigation',
      'capabilities'
    )
  ),
  component_revision bigint not null check (component_revision > 0),
  source_event_id uuid not null,
  payload jsonb not null,
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, component),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, source_event_id),
  check (jsonb_typeof(payload) in ('object', 'array', 'null'))
);

create index dashboard_components_user_revision_idx
  on home.dashboard_components (tenant_id, user_id, component_revision desc);

alter table home.dashboard_components enable row level security;

create policy dashboard_components_tenant_isolation on home.dashboard_components
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table home.dashboard_components force row level security;
