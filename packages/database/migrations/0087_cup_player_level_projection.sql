-- Expand-only inbox and ordering fence for authoritative CUP player-level snapshots.
-- The runtime consumer is disabled by default; applying this migration cannot change a profile.
-- phub:reviewed-new-table-index

create table eligibility.cup_player_level_projections (
  tenant_id uuid not null references identity.tenants(id),
  player_id uuid not null,
  sport_code text not null check (sport_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  external_mapping_id uuid not null,
  source_revision bigint not null check (source_revision >= 0),
  source_event_id text not null
    check (char_length(btrim(source_event_id)) between 8 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  level_id uuid not null,
  source_event_type text not null
    check (source_event_type in (
      'RATING_INITIAL_IMPORTED',
      'RATING_BOOTSTRAPPED_FROM_VIVA',
      'RATING_MANUALLY_CHANGED'
    )),
  formula_version text not null
    check (formula_version = 'padel-rating-grade-v1'),
  occurred_at timestamptz not null,
  applied_at timestamptz not null default now(),
  primary key (tenant_id, player_id, sport_code),
  unique (tenant_id, source_event_id),
  foreign key (tenant_id, player_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, external_mapping_id)
    references integration.external_entity_map(tenant_id, id),
  foreign key (tenant_id, sport_code, level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id)
);

create index cup_player_level_projection_mapping_idx
  on eligibility.cup_player_level_projections (tenant_id, external_mapping_id);

-- Immutable idempotency ledger: the latest-state row above may replace its event reference, but
-- an old CUP event id must never become reusable after a later revision is applied.
create table eligibility.cup_player_level_projection_events (
  tenant_id uuid not null references identity.tenants(id),
  source_event_id text not null
    check (char_length(btrim(source_event_id)) between 8 and 200),
  player_id uuid not null,
  sport_code text not null check (sport_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  source_revision bigint not null check (source_revision >= 0),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  primary key (tenant_id, source_event_id),
  foreign key (tenant_id, player_id) references identity.users(tenant_id, id)
);

alter table eligibility.cup_player_level_projections enable row level security;

create policy cup_player_level_projections_tenant_isolation
  on eligibility.cup_player_level_projections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table eligibility.cup_player_level_projections force row level security;

alter table eligibility.cup_player_level_projection_events enable row level security;

create policy cup_player_level_projection_events_tenant_isolation
  on eligibility.cup_player_level_projection_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table eligibility.cup_player_level_projection_events force row level security;
