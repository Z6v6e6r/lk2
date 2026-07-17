-- Expand-only producer state for the normalized community summaries embedded in Home.
-- The temporary legacy adapter and the later canonical repository both publish the same
-- PadlHub-owned component contract through the transactional outbox.

create table integration.community_home_source_components (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  source_mode text not null check (source_mode in ('LEGACY', 'LOCAL')),
  source_revision bigint not null check (source_revision > 0),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) <= 5
  ),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  correlation_id text not null,
  fetched_at timestamptz not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index community_home_source_due_idx
  on integration.community_home_source_components (tenant_id, last_synced_at, user_id);

alter table integration.community_home_source_components enable row level security;

create policy community_home_source_components_tenant_isolation
  on integration.community_home_source_components
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.community_home_source_components force row level security;
