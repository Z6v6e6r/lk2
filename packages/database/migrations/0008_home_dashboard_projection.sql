-- Expand-only, tenant-isolated storage for one complete Home dashboard snapshot.
-- Projection producers replace a row only with a higher source revision.

create schema if not exists home;

create table home.dashboard_snapshots (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  source_event_id uuid not null,
  producer text not null check (producer ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  snapshot_version text not null check (char_length(snapshot_version) between 1 and 100),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null,
  stale_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, source_event_id),
  check (stale_at > generated_at),
  check (payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'),
  check (payload #>> '{snapshot,version}' = snapshot_version),
  check (payload #>> '{profile,userId}' = user_id::text)
);

create index dashboard_snapshots_stale_idx
  on home.dashboard_snapshots (tenant_id, stale_at, user_id);

alter table home.dashboard_snapshots enable row level security;

create policy dashboard_snapshots_tenant_isolation on home.dashboard_snapshots
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table home.dashboard_snapshots force row level security;
