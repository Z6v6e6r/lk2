-- A bounded migration mirror for legacy LK rosters. It is deliberately separate from
-- the canonical Games command path: a revision mismatch quarantines the mirror rather
-- than overwriting a locally changed aggregate.

create table integration.legacy_game_roster_sync_state (
  tenant_id uuid not null references identity.tenants(id),
  game_id uuid not null,
  source_external_version text not null,
  last_synced_game_revision bigint not null check (last_synced_game_revision > 0),
  mode text not null default 'MIRROR' check (mode in ('MIRROR', 'CONFLICT', 'DISABLED')),
  last_synced_at timestamptz not null default now(),
  conflict_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, game_id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  check ((mode = 'CONFLICT') = (conflict_code is not null))
);

create index legacy_game_roster_sync_state_mirror_idx
  on integration.legacy_game_roster_sync_state (tenant_id, last_synced_at)
  where mode = 'MIRROR';

alter table integration.legacy_game_roster_sync_state enable row level security;
create policy legacy_game_roster_sync_state_tenant_isolation
  on integration.legacy_game_roster_sync_state
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table integration.legacy_game_roster_sync_state force row level security;
