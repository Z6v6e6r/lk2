-- Expand-only, tenant-isolated read model for a user's completed and cancelled
-- games, trainings and tournaments. Provider identifiers stay in integration
-- storage; the projection may reference only an opaque integration mapping UUID.

alter table integration.external_entity_map
  add constraint external_entity_map_tenant_id_id_unique unique (tenant_id, id);

create table booking.activity_history_projection (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  id uuid not null,
  kind text not null check (kind in ('GAME', 'TRAINING', 'TOURNAMENT')),
  status text not null check (status in ('COMPLETED', 'CANCELLED')),
  occurred_at timestamptz not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  venue_name text check (
    venue_name is null or char_length(btrim(venue_name)) between 1 and 300
  ),
  route text check (
    route is null or (
      char_length(route) between 1 and 500
      and route like '/%'
      and route not like '%://%'
    )
  ),
  game_id uuid,
  tournament_id uuid,
  source_mapping_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  source_revision text not null
    check (char_length(btrim(source_revision)) between 1 and 200),
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, source_mapping_id)
    references integration.external_entity_map(tenant_id, id),
  check (ends_at is null or ends_at > starts_at),
  check (game_id is null or kind = 'GAME'),
  check (tournament_id is null or kind = 'TOURNAMENT')
);

create unique index activity_history_source_mapping_idx
  on booking.activity_history_projection (tenant_id, user_id, source_mapping_id)
  where source_mapping_id is not null;

create index activity_history_user_timeline_idx
  on booking.activity_history_projection (tenant_id, user_id, occurred_at desc, id desc);

create index activity_history_user_kind_timeline_idx
  on booking.activity_history_projection (
    tenant_id, user_id, kind, occurred_at desc, id desc
  );

create index activity_history_user_status_timeline_idx
  on booking.activity_history_projection (
    tenant_id, user_id, status, occurred_at desc, id desc
  );

create table integration.user_activity_history_sync_state (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  coverage_status text not null default 'UNSYNCED'
    check (coverage_status in ('UNSYNCED', 'PARTIAL', 'COMPLETE')),
  last_success_at timestamptz,
  stale_at timestamptz,
  oldest_synced_at timestamptz,
  next_provider_cursor text,
  source_revision text,
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (
    (coverage_status = 'UNSYNCED'
      and last_success_at is null
      and stale_at is null
      and oldest_synced_at is null
      and next_provider_cursor is null
      and source_revision is null)
    or
    (coverage_status = 'PARTIAL'
      and last_success_at is not null
      and stale_at > last_success_at
      and next_provider_cursor is not null
      and nullif(btrim(source_revision), '') is not null)
    or
    (coverage_status = 'COMPLETE'
      and last_success_at is not null
      and stale_at > last_success_at
      and next_provider_cursor is null
      and nullif(btrim(source_revision), '') is not null)
  )
);

create index user_activity_history_sync_due_idx
  on integration.user_activity_history_sync_state (tenant_id, stale_at, user_id)
  where coverage_status <> 'UNSYNCED';

alter table booking.activity_history_projection enable row level security;
alter table integration.user_activity_history_sync_state enable row level security;

create policy activity_history_projection_tenant_isolation
  on booking.activity_history_projection
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy user_activity_history_sync_state_tenant_isolation
  on integration.user_activity_history_sync_state
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table booking.activity_history_projection force row level security;
alter table integration.user_activity_history_sync_state force row level security;
