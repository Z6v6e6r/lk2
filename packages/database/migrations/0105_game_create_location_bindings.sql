-- Expand only. Dedicated worker remains off; CREATE commands remain unavailable.
-- Public courts currently have aliases, not a canonical court table. The provenance FK protects
-- row identity; the repository checks semantic court identity against the complete lineage.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create table integration.game_create_location_bindings (
  tenant_id uuid not null references identity.tenants(id),
  court_id uuid not null,
  id uuid not null default gen_random_uuid(),
  station_id uuid not null,
  court_mapping_id uuid not null,
  provider_tenant_key text not null check (provider_tenant_key = 'iSkq6G'),
  provider_studio_id text not null check (provider_studio_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  provider_room_id text not null check (provider_room_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  revision bigint not null check (revision > 0),
  state text not null check (state in ('ACTIVE', 'REVOKED')),
  lineage_digest text not null check (lineage_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_command_id uuid not null,
  last_command_hash text not null check (last_command_hash ~ '^[0-9a-f]{64}$'),
  primary key (tenant_id, court_id),
  unique (tenant_id, id),
  foreign key (tenant_id, station_id) references locations.profiles(tenant_id, id),
  foreign key (tenant_id, court_mapping_id) references integration.external_entity_map(tenant_id, id),
  check (expires_at = verified_at + interval '5 minutes'),
  check ((state = 'REVOKED') = (revoked_at is not null))
);
-- phub:reviewed-new-table-index -- new empty additive integration table.
create unique index game_create_location_binding_active_room_unique
  on integration.game_create_location_bindings(tenant_id, provider_tenant_key, provider_room_id)
  where state = 'ACTIVE';
alter table integration.game_create_location_bindings enable row level security;
alter table integration.game_create_location_bindings force row level security;
create policy game_create_location_bindings_tenant_isolation
  on integration.game_create_location_bindings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
