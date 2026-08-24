\set ON_ERROR_STOP on

-- Read-only, anonymized eligibility audit. Required variables:
--   psql "$DATABASE_URL" -v tenant_id='<uuid>' -v stale_before='<timestamptz>' \
--     -f scripts/audit-level-eligibility-readiness.sql
-- Run only against an explicitly authorized database and role.

begin;
set transaction read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
select set_config('app.tenant_id', :'tenant_id', true);

with expected(code, rank) as (
  values ('D', 1), ('D+', 2), ('C', 3), ('C+', 4), ('B', 5), ('B+', 6), ('A', 7)
)
select 'canonical_scale_missing_or_incorrect' as metric, count(*)::bigint as value
  from expected
  left join eligibility.canonical_levels level
    on level.tenant_id = :'tenant_id'::uuid
   and level.sport_code = 'PADEL'
   and level.scale_version = 1
   and level.code = expected.code
   and level.rank = expected.rank
   and level.active
 where level.id is null;

with expected(code, rank) as (
  values ('D', 1), ('D+', 2), ('C', 3), ('C+', 4), ('B', 5), ('B+', 6), ('A', 7)
)
select 'canonical_scale_extra_or_incorrect' as metric, count(*)::bigint as value
  from eligibility.canonical_levels level
  left join expected
    on expected.code = level.code and expected.rank = level.rank
 where level.tenant_id = :'tenant_id'::uuid
   and level.sport_code = 'PADEL'
   and level.scale_version = 1
   and level.active
   and expected.code is null;

with expected(activity_type) as (values ('GAME'), ('TOURNAMENT'), ('TRAINING'))
select 'missing_active_policy' as metric, count(*)::bigint as value
  from expected
  left join eligibility.level_policies policy
    on policy.tenant_id = :'tenant_id'::uuid
   and policy.sport_code = 'PADEL'
   and policy.activity_type = expected.activity_type
   and policy.active
 where policy.id is null;

with expected(activity_type) as (values ('GAME'), ('TOURNAMENT'), ('TRAINING'))
select 'missing_readiness_row' as metric, count(*)::bigint as value
  from expected
  left join eligibility.activation_readiness readiness
    on readiness.tenant_id = :'tenant_id'::uuid
   and readiness.sport_code = 'PADEL'
   and readiness.activity_type = expected.activity_type
 where readiness.activity_type is null;

select 'players_without_canonical_level' as metric, count(*)::bigint as value
  from identity.users player
  left join eligibility.player_sport_levels level
    on level.tenant_id = player.tenant_id
   and level.player_id = player.id
   and level.sport_code = 'PADEL'
 where player.tenant_id = :'tenant_id'::uuid
   and player.status = 'ACTIVE'
   and level.player_id is null;

select 'stale_player_levels' as metric, count(*)::bigint as value
  from eligibility.player_sport_levels level
  join identity.users player
    on player.tenant_id = level.tenant_id and player.id = level.player_id
 where level.tenant_id = :'tenant_id'::uuid
   and level.sport_code = 'PADEL'
   and player.status = 'ACTIVE'
   and level.updated_at < :'stale_before'::timestamptz;

select 'player_level_scale_mismatch' as metric, count(*)::bigint as value
  from eligibility.player_sport_levels player_level
  join eligibility.canonical_levels canonical
    on canonical.tenant_id = player_level.tenant_id
   and canonical.sport_code = player_level.sport_code
   and canonical.id = player_level.level_id
 where player_level.tenant_id = :'tenant_id'::uuid
   and player_level.sport_code = 'PADEL'
   and (not canonical.active or canonical.scale_version <> player_level.scale_version);

select 'unmapped_legacy_profile_levels' as metric, count(*)::bigint as value
  from profile.user_summaries summary
 where summary.tenant_id = :'tenant_id'::uuid
   and summary.level_label is not null
   and not exists (
     select 1
       from eligibility.canonical_levels canonical
      where canonical.tenant_id = summary.tenant_id
        and canonical.sport_code = 'PADEL'
        and canonical.active
        and (canonical.code = summary.level_label or summary.level_label = any(canonical.aliases))
   );

select 'games_without_canonical_range' as metric, count(*)::bigint as value
  from games.games game
 where game.tenant_id = :'tenant_id'::uuid
   and game.lifecycle_state = 'SCHEDULED'
   and (game.min_level_id is null or game.max_level_id is null);

select 'games_with_scale_mismatch' as metric, count(*)::bigint as value
  from games.games game
  join eligibility.canonical_levels minimum
    on minimum.tenant_id = game.tenant_id
   and minimum.sport_code = game.sport_code
   and minimum.id = game.min_level_id
  join eligibility.canonical_levels maximum
    on maximum.tenant_id = game.tenant_id
   and maximum.sport_code = game.sport_code
   and maximum.id = game.max_level_id
 where game.tenant_id = :'tenant_id'::uuid
   and game.lifecycle_state = 'SCHEDULED'
   and minimum.scale_version <> maximum.scale_version;

select 'games_with_invalid_canonical_range' as metric, count(*)::bigint as value
  from games.games game
  join eligibility.canonical_levels minimum
    on minimum.tenant_id = game.tenant_id
   and minimum.sport_code = game.sport_code
   and minimum.id = game.min_level_id
  join eligibility.canonical_levels maximum
    on maximum.tenant_id = game.tenant_id
   and maximum.sport_code = game.sport_code
   and maximum.id = game.max_level_id
 where game.tenant_id = :'tenant_id'::uuid
   and game.lifecycle_state = 'SCHEDULED'
   and (
     not minimum.active
     or not maximum.active
     or minimum.scale_version <> maximum.scale_version
     or minimum.rank > maximum.rank
   );

select activity_type, mode, version,
       writer_authoritative, player_projection_ready,
       client_recovery_ready, payment_recovery_ready,
       verified_at
  from eligibility.activation_readiness readiness
  join eligibility.level_policies policy
    using (tenant_id, sport_code, activity_type)
 where readiness.tenant_id = :'tenant_id'::uuid
   and readiness.sport_code = 'PADEL'
   and policy.active
 order by activity_type;

select activity_type, action, outcome, reason_code,
       count(*)::bigint as decisions,
       count(*) filter (where details->>'wouldBlock' = 'true')::bigint as shadow_would_block
  from eligibility.decisions
 where tenant_id = :'tenant_id'::uuid
   and evaluated_at >= now() - interval '30 days'
 group by activity_type, action, outcome, reason_code
 order by activity_type, action, outcome, reason_code;

select status, count(*)::bigint as personal_invitations
  from eligibility.personal_invitations
 where tenant_id = :'tenant_id'::uuid
   and invitation_type = 'PERSONAL'
 group by status
 order by status;

select activity_type, 'UNSUPPORTED_WRITER' as status
  from (values ('TOURNAMENT'), ('TRAINING')) as unsupported(activity_type)
 order by activity_type;

rollback;
