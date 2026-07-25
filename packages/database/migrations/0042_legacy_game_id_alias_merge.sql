-- Expand the integration map so one canonical PadlHub aggregate can retain every observed
-- provider/source alias. External IDs remain integration-only.

do $migration$
declare
  internal_unique_constraint text;
begin
  select constraint_row.conname
    into internal_unique_constraint
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'integration.external_entity_map'::regclass
     and constraint_row.contype = 'u'
     and pg_get_constraintdef(constraint_row.oid) like '%internal_id%'
   limit 1;

  if internal_unique_constraint is not null then
    execute format(
      'alter table integration.external_entity_map drop constraint %I',
      internal_unique_constraint
    );
  end if;
end
$migration$;

create index external_entity_map_internal_alias_idx
  on integration.external_entity_map (
    tenant_id, external_system, entity_type, internal_id, last_synced_at desc
  );

create unique index external_entity_map_canonical_internal_idx
  on integration.external_entity_map (
    tenant_id, external_system, entity_type, internal_id
  )
  where not (
    external_system = 'LK_LEGACY_SNAPSHOT'
    and entity_type in ('game', 'game_player', 'game_station', 'game_court')
  );

create table integration.legacy_game_merge_redirects (
  tenant_id uuid not null references identity.tenants(id),
  source_game_id uuid not null,
  target_game_id uuid not null,
  merge_reason text not null check (
    merge_reason in ('SOURCE_AND_PSEUDONYMOUS_ID_ALIAS')
  ),
  merged_at timestamptz not null default now(),
  primary key (tenant_id, source_game_id),
  foreign key (tenant_id, source_game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, target_game_id) references games.games(tenant_id, id),
  check (source_game_id <> target_game_id)
);

create index legacy_game_merge_redirect_target_idx
  on integration.legacy_game_merge_redirects (tenant_id, target_game_id);

alter table integration.legacy_game_merge_redirects enable row level security;
create policy legacy_game_merge_redirects_tenant_isolation
  on integration.legacy_game_merge_redirects
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table integration.legacy_game_merge_redirects force row level security;

create temporary table legacy_game_alias_pairs (
  tenant_id uuid not null,
  source_game_id uuid not null,
  target_game_id uuid not null,
  primary key (tenant_id, source_game_id)
) on commit drop;

insert into legacy_game_alias_pairs (tenant_id, source_game_id, target_game_id)
select source_mapping.tenant_id,
       source_mapping.internal_id,
       canonical_mapping.internal_id
  from integration.external_entity_map source_mapping
  join integration.external_entity_map canonical_mapping
    on canonical_mapping.tenant_id = source_mapping.tenant_id
   and canonical_mapping.external_system = source_mapping.external_system
   and canonical_mapping.entity_type = source_mapping.entity_type
   and canonical_mapping.external_id = encode(
     digest(
       'phub-local-public-clone-v1:game:' || source_mapping.external_id,
       'sha256'
     ),
     'hex'
   )
 where source_mapping.external_system = 'LK_LEGACY_SNAPSHOT'
   and source_mapping.entity_type = 'game'
   and source_mapping.external_id !~ '^[0-9a-f]{64}$'
   and source_mapping.internal_id <> canonical_mapping.internal_id
on conflict (tenant_id, source_game_id) do update set
  target_game_id = excluded.target_game_id;

insert into integration.legacy_game_merge_redirects (
  tenant_id, source_game_id, target_game_id, merge_reason, merged_at
)
select tenant_id, source_game_id, target_game_id,
       'SOURCE_AND_PSEUDONYMOUS_ID_ALIAS', now()
  from legacy_game_alias_pairs
on conflict (tenant_id, source_game_id) do update set
  target_game_id = excluded.target_game_id,
  merge_reason = excluded.merge_reason,
  merged_at = excluded.merged_at;

update integration.external_entity_map mapping
   set internal_id = pair.target_game_id,
       last_synced_at = now(),
       sync_status = 'synced',
       sync_error_code = null
  from legacy_game_alias_pairs pair
 where mapping.tenant_id = pair.tenant_id
   and mapping.internal_id = pair.source_game_id
   and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
   and mapping.entity_type = 'game';

-- Preserve the one-exercise-per-game invariant. A source link moves when the target has no Viva
-- link; otherwise it stays attached to the lossless redirect source and read paths resolve it to
-- the canonical target.
update integration.external_entity_map mapping
   set internal_id = pair.target_game_id,
       last_synced_at = now(),
       sync_status = 'synced',
       sync_error_code = null
  from legacy_game_alias_pairs pair
 where mapping.tenant_id = pair.tenant_id
   and mapping.internal_id = pair.source_game_id
   and mapping.external_system = 'VIVA'
   and mapping.entity_type = 'exercise'
   and not exists (
     select 1
       from integration.external_entity_map target_mapping
      where target_mapping.tenant_id = pair.tenant_id
        and target_mapping.external_system = mapping.external_system
        and target_mapping.entity_type = mapping.entity_type
        and target_mapping.internal_id = pair.target_game_id
   );

update booking.activity_history_projection history
   set game_id = pair.target_game_id,
       updated_at = now()
  from legacy_game_alias_pairs pair
 where history.tenant_id = pair.tenant_id
   and history.game_id = pair.source_game_id;

update integration.legacy_game_roster_sync_state state
   set mode = 'DISABLED',
       conflict_code = null,
       updated_at = now()
  from legacy_game_alias_pairs pair
 where state.tenant_id = pair.tenant_id
   and state.game_id = pair.source_game_id;

update games.scheduled_commands command
   set state = 'COMPLETED',
       completed_at = coalesce(command.completed_at, now()),
       locked_at = null,
       locked_by = null
  from legacy_game_alias_pairs pair
 where command.tenant_id = pair.tenant_id
   and command.game_id = pair.source_game_id
   and command.state in ('PENDING', 'FAILED');

delete from games.card_projections projection
 using legacy_game_alias_pairs pair
 where projection.tenant_id = pair.tenant_id
   and projection.game_id = pair.source_game_id;

insert into audit.audit_log (
  tenant_id, actor_id, action, resource_type, resource_id, result,
  reason, correlation_id, old_value, new_value
)
select pair.tenant_id, null, 'LEGACY_GAME_ALIAS_PAIR_MERGED', 'GAME',
       pair.target_game_id, 'SUCCESS', 'SOURCE_AND_PSEUDONYMOUS_ID_ALIAS',
       'migration-0042-legacy-game-id-alias-merge',
       jsonb_build_object('sourceGameId', pair.source_game_id),
       jsonb_build_object('targetGameId', pair.target_game_id)
  from legacy_game_alias_pairs pair;
