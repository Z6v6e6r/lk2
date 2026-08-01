-- Expand-only storage for the partial, PadlHub-owned Home recovery projection.
-- The payload deliberately excludes profile, booking, subscription and balance data.

create table home.base_snapshots (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  source_event_id uuid not null,
  producer text not null check (producer ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  snapshot_version text not null check (char_length(snapshot_version) between 1 and 100),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, source_event_id),
  check (payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'),
  check (payload #>> '{snapshot,completeness}' = 'PARTIAL'),
  check (payload #>> '{snapshot,version}' = snapshot_version),
  check (payload #>> '{viewerUserId}' = user_id::text),
  check (not (payload ? 'profile')),
  check (not (payload ? 'upcoming')),
  check (not (payload ? 'subscriptions')),
  check (not (payload ? 'counters'))
);

create index home_base_snapshots_checked_idx
  on home.base_snapshots (tenant_id, checked_at, user_id);

alter table home.base_snapshots enable row level security;

create policy home_base_snapshots_tenant_isolation on home.base_snapshots
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table home.base_snapshots force row level security;
