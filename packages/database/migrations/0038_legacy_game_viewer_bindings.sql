-- Expand-only server-side association between a one-way legacy player key and the
-- authenticated PadlHub user proven by Viva/CUP history. The raw phone and provider
-- identifiers never enter this table.

create table integration.legacy_game_player_bindings (
  tenant_id uuid not null references identity.tenants(id),
  source_player_association_id text not null
    check (source_player_association_id ~ '^[0-9a-f]{64}$'),
  user_id uuid not null,
  proof_kind text not null check (proof_kind in ('VIVA_PROFILE', 'VIEWER_PHONE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, source_player_association_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index legacy_game_player_bindings_user_idx
  on integration.legacy_game_player_bindings (tenant_id, user_id);

alter table integration.legacy_game_player_bindings enable row level security;

create policy legacy_game_player_bindings_tenant_isolation
  on integration.legacy_game_player_bindings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.legacy_game_player_bindings force row level security;
