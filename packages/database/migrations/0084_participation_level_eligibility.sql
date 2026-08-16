-- Expand-only foundation for one PadlHub-owned participation eligibility contour.
-- All seeded policies are OFF. This migration cannot block an existing registration.
-- phub:reviewed-new-table-index

create schema if not exists eligibility;

create table eligibility.canonical_levels (
  tenant_id uuid not null references identity.tenants(id),
  sport_code text not null check (sport_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  id uuid not null default gen_random_uuid(),
  code text not null check (char_length(btrim(code)) between 1 and 32),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  rank integer not null check (rank >= 0),
  sort_order integer not null check (sort_order >= 0),
  aliases text[] not null default '{}',
  active boolean not null default true,
  scale_version integer not null check (scale_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, sport_code, id),
  unique (tenant_id, sport_code, scale_version, code),
  unique (tenant_id, sport_code, scale_version, rank)
);

insert into eligibility.canonical_levels (
  tenant_id, sport_code, code, title, rank, sort_order, aliases, scale_version
)
select tenant.id, 'PADEL', level.code, level.title, level.rank, level.rank, level.aliases, 1
  from identity.tenants tenant
 cross join (values
   ('D', 'D', 1, array['D']::text[]),
   ('D+', 'D+', 2, array['D+']::text[]),
   ('C', 'C', 3, array['C']::text[]),
   ('C+', 'C+', 4, array['C+']::text[]),
   ('B', 'B', 5, array['B']::text[]),
   ('B+', 'B+', 6, array['B+']::text[]),
   ('A', 'A', 7, array['A']::text[])
 ) as level(code, title, rank, aliases)
on conflict do nothing;

create table eligibility.player_sport_levels (
  tenant_id uuid not null,
  player_id uuid not null,
  sport_code text not null,
  level_id uuid not null,
  source text not null check (source in (
    'SELF_DECLARED', 'ONBOARDING', 'MANUAL', 'CALCULATED', 'VIVA', 'MIGRATED'
  )),
  scale_version integer not null check (scale_version > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, player_id, sport_code),
  foreign key (tenant_id, player_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, sport_code, level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id)
);

insert into eligibility.player_sport_levels (
  tenant_id, player_id, sport_code, level_id, source, scale_version, updated_at
)
select summary.tenant_id, summary.user_id, 'PADEL', level.id, 'MIGRATED', 1, summary.updated_at
  from profile.user_summaries summary
  join eligibility.canonical_levels level
    on level.tenant_id = summary.tenant_id
   and level.sport_code = 'PADEL'
   and level.scale_version = 1
   and level.code = summary.level_label
 where summary.level_label is not null
on conflict do nothing;

create table eligibility.level_policies (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  sport_code text not null check (sport_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  mode text not null check (mode in ('OFF', 'SHADOW', 'WARN', 'BLOCK')),
  lower_tolerance_steps integer not null default 0 check (lower_tolerance_steps >= 0),
  upper_tolerance_steps integer not null default 0 check (upper_tolerance_steps >= 0),
  missing_activity_constraint_action text not null default 'ALLOW'
    check (missing_activity_constraint_action in ('ALLOW', 'WARN', 'BLOCK')),
  legacy_text_constraint_action text not null default 'ALLOW'
    check (legacy_text_constraint_action in ('ALLOW', 'WARN')),
  recheck_waitlist_promotion boolean not null default true,
  version integer not null check (version > 0),
  active boolean not null default true,
  change_comment text check (change_comment is null or char_length(change_comment) <= 500),
  updated_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, sport_code, activity_type, version),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id)
);

create unique index eligibility_level_policy_active_idx
  on eligibility.level_policies (tenant_id, sport_code, activity_type)
  where active;

create table eligibility.policy_commands (
  tenant_id uuid not null references identity.tenants(id),
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  check (char_length(idempotency_key) between 8 and 200),
  check (jsonb_typeof(result_payload) = 'object')
);

create table eligibility.activation_readiness (
  tenant_id uuid not null references identity.tenants(id),
  sport_code text not null,
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  writer_authoritative boolean not null default false,
  player_projection_ready boolean not null default false,
  client_recovery_ready boolean not null default false,
  payment_recovery_ready boolean not null default false,
  verified_at timestamptz,
  verified_by uuid,
  evidence jsonb not null default '{}',
  primary key (tenant_id, sport_code, activity_type),
  foreign key (tenant_id, verified_by) references identity.users(tenant_id, id),
  check (jsonb_typeof(evidence) = 'object')
);

insert into eligibility.level_policies (
  tenant_id, sport_code, activity_type, mode, version, change_comment
)
select tenant.id, 'PADEL', activity.activity_type, 'OFF', 1, 'Safe initial policy'
  from identity.tenants tenant
 cross join (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
on conflict do nothing;

insert into eligibility.activation_readiness (tenant_id, sport_code, activity_type)
select tenant.id, 'PADEL', activity.activity_type
  from identity.tenants tenant
 cross join (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
on conflict do nothing;

create table eligibility.personal_invitations (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  activity_id uuid not null,
  invitation_type text not null check (invitation_type in ('PERSONAL', 'PUBLIC_LINK', 'COMMUNITY', 'TEAM', 'ADMIN')),
  recipient_player_id uuid not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'USED', 'REVOKED', 'EXPIRED')),
  max_uses integer not null default 1 check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  used_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, recipient_player_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id),
  check (expires_at > created_at),
  check ((status = 'REVOKED') = (revoked_at is not null))
);

create index eligibility_personal_invitation_lookup_idx
  on eligibility.personal_invitations (tenant_id, activity_type, activity_id, recipient_player_id)
  where status = 'ACTIVE' and invitation_type = 'PERSONAL';

create table eligibility.decisions (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  player_id uuid not null,
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  activity_id uuid not null,
  action text not null,
  status text not null check (status in ('ALLOWED', 'WARNING', 'DENIED')),
  rule_code text not null,
  outcome text not null check (outcome in ('PASS', 'SKIP', 'WARN', 'FAIL', 'BYPASS')),
  reason_code text not null,
  policy_version integer not null,
  level_scale_version integer,
  constraint_source text,
  invitation_id uuid,
  details jsonb not null default '{}',
  evaluated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, player_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, invitation_id) references eligibility.personal_invitations(tenant_id, id),
  check (jsonb_typeof(details) = 'object')
);

create index eligibility_decisions_observability_idx
  on eligibility.decisions (tenant_id, activity_type, reason_code, evaluated_at desc);

create table eligibility.payment_snapshots (
  tenant_id uuid not null references identity.tenants(id),
  operation_id uuid not null,
  decision_id uuid not null,
  player_id uuid not null,
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  activity_id uuid not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, operation_id),
  foreign key (tenant_id, decision_id) references eligibility.decisions(tenant_id, id),
  foreign key (tenant_id, player_id) references identity.users(tenant_id, id),
  check (jsonb_typeof(snapshot) = 'object')
);

alter table games.games
  add column sport_code text not null default 'PADEL',
  add column min_level_id uuid,
  add column max_level_id uuid,
  add constraint games_level_range_ids_together check (
    (min_level_id is null and max_level_id is null)
    or (min_level_id is not null and max_level_id is not null)
  ),
  add foreign key (tenant_id, sport_code, min_level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id),
  add foreign key (tenant_id, sport_code, max_level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id);

update games.games game
   set min_level_id = minimum.id,
       max_level_id = maximum.id
  from eligibility.canonical_levels minimum,
       eligibility.canonical_levels maximum
 where minimum.tenant_id = game.tenant_id
   and maximum.tenant_id = game.tenant_id
   and minimum.sport_code = game.sport_code
   and maximum.sport_code = game.sport_code
   and minimum.scale_version = 1
   and maximum.scale_version = 1
   and minimum.code = game.level_from
   and maximum.code = game.level_to
   and game.level_from is not null
   and game.level_to is not null;

alter table games.participations add column eligibility_decision_id uuid;
alter table games.participations
  add foreign key (tenant_id, eligibility_decision_id) references eligibility.decisions(tenant_id, id);
alter table games.seat_reservations add column eligibility_decision_id uuid;
alter table games.seat_reservations
  add foreign key (tenant_id, eligibility_decision_id) references eligibility.decisions(tenant_id, id);
alter table games.waitlist_entries
  add column eligibility_decision_id uuid,
  add column personal_invitation_id uuid;
alter table games.waitlist_entries
  add foreign key (tenant_id, eligibility_decision_id) references eligibility.decisions(tenant_id, id),
  add foreign key (tenant_id, personal_invitation_id) references eligibility.personal_invitations(tenant_id, id);

alter table eligibility.canonical_levels enable row level security;
alter table eligibility.player_sport_levels enable row level security;
alter table eligibility.level_policies enable row level security;
alter table eligibility.policy_commands enable row level security;
alter table eligibility.activation_readiness enable row level security;
alter table eligibility.personal_invitations enable row level security;
alter table eligibility.decisions enable row level security;
alter table eligibility.payment_snapshots enable row level security;

create policy eligibility_canonical_levels_tenant_isolation on eligibility.canonical_levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_player_levels_tenant_isolation on eligibility.player_sport_levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_level_policies_tenant_isolation on eligibility.level_policies
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_policy_commands_tenant_isolation on eligibility.policy_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_activation_readiness_tenant_isolation on eligibility.activation_readiness
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_personal_invitations_tenant_isolation on eligibility.personal_invitations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_decisions_tenant_isolation on eligibility.decisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy eligibility_payment_snapshots_tenant_isolation on eligibility.payment_snapshots
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table eligibility.canonical_levels force row level security;
alter table eligibility.player_sport_levels force row level security;
alter table eligibility.level_policies force row level security;
alter table eligibility.policy_commands force row level security;
alter table eligibility.activation_readiness force row level security;
alter table eligibility.personal_invitations force row level security;
alter table eligibility.decisions force row level security;
alter table eligibility.payment_snapshots force row level security;
