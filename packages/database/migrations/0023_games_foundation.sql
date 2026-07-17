-- Expand-only canonical Games storage. Games are LOCAL_PRIMARY: a command commits the
-- aggregate, idempotency result, audit record and outbox facts in one PostgreSQL transaction.
-- Provider identifiers remain in integration.external_entity_map and never enter these tables.

create table games.games (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  revision bigint not null default 1 check (revision > 0),
  organizer_user_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  kind text not null check (kind in ('FRIENDLY', 'RATING', 'PRIVATE', 'COACH_GAME')),
  visibility text not null check (visibility in ('PUBLIC', 'PRIVATE', 'COMMUNITY')),
  lifecycle_state text not null default 'DRAFT'
    check (lifecycle_state in ('DRAFT', 'PROVISIONING', 'SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED')),
  station_id uuid not null,
  court_id uuid,
  booking_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  capacity smallint not null check (capacity between 2 and 4),
  waitlist_enabled boolean not null default false,
  join_cutoff_at timestamptz,
  payment_mode text not null
    check (payment_mode in ('ORGANIZER_PAYS', 'SPLIT', 'SUBSCRIPTION', 'NO_PAYMENT')),
  level_from text check (level_from is null or level_from in ('D', 'D+', 'C', 'C+', 'B', 'B+', 'A')),
  level_to text check (level_to is null or level_to in ('D', 'D+', 'C', 'C+', 'B', 'B+', 'A')),
  result_state text not null default 'NOT_AVAILABLE'
    check (result_state in ('NOT_AVAILABLE', 'AWAITING_SUBMISSION', 'PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'VOID')),
  card_projection_revision bigint check (card_projection_revision is null or card_projection_revision > 0),
  cancellation_reason_code text check (
    cancellation_reason_code is null or cancellation_reason_code in (
      'ORGANIZER_REQUEST', 'VENUE_UNAVAILABLE', 'WEATHER', 'SAFETY',
      'PROVISIONING_FAILED', 'OTHER'
    )
  ),
  cancelled_by_user_id uuid,
  cancelled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, organizer_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, cancelled_by_user_id) references identity.users(tenant_id, id),
  check (ends_at > starts_at),
  check (join_cutoff_at is null or join_cutoff_at <= starts_at),
  check (
    (lifecycle_state = 'CANCELLED' and cancellation_reason_code is not null and cancelled_at is not null)
    or (lifecycle_state <> 'CANCELLED' and cancellation_reason_code is null and cancelled_at is null and cancelled_by_user_id is null)
  ),
  check (started_at is null or started_at >= created_at),
  check (finished_at is null or (started_at is not null and finished_at >= started_at)),
  check (
    (lifecycle_state in ('DRAFT', 'PROVISIONING', 'SCHEDULED') and started_at is null and finished_at is null)
    or (lifecycle_state = 'IN_PROGRESS' and started_at is not null and finished_at is null)
    or (lifecycle_state = 'FINISHED' and started_at is not null and finished_at is not null)
    or lifecycle_state = 'CANCELLED'
  ),
  check (
    (lifecycle_state = 'FINISHED' and result_state <> 'NOT_AVAILABLE')
    or (lifecycle_state = 'CANCELLED' and result_state in ('NOT_AVAILABLE', 'VOID'))
    or (lifecycle_state not in ('FINISHED', 'CANCELLED') and result_state = 'NOT_AVAILABLE')
  )
);

create index games_discovery_idx
  on games.games (tenant_id, starts_at, id)
  where lifecycle_state = 'SCHEDULED' and visibility = 'PUBLIC';

create index games_organizer_timeline_idx
  on games.games (tenant_id, organizer_user_id, starts_at desc, id);

create index games_lifecycle_due_idx
  on games.games (tenant_id, lifecycle_state, starts_at, ends_at, id)
  where lifecycle_state in ('SCHEDULED', 'IN_PROGRESS');

create table games.participations (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  role text not null check (role in ('ORGANIZER', 'PLAYER')),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'LEFT', 'REMOVED')),
  payment_state text not null default 'NOT_REQUIRED'
    check (payment_state in ('NOT_REQUIRED', 'PAID', 'REFUND_PENDING', 'REFUNDED')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, game_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check ((state = 'ACTIVE' and left_at is null) or (state <> 'ACTIVE' and left_at is not null))
);

create unique index games_active_participation_user_idx
  on games.participations (tenant_id, game_id, user_id)
  where state = 'ACTIVE';

create unique index games_active_organizer_idx
  on games.participations (tenant_id, game_id)
  where state = 'ACTIVE' and role = 'ORGANIZER';

create index games_participation_user_timeline_idx
  on games.participations (tenant_id, user_id, state, joined_at desc, game_id);

create table games.seat_reservations (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  payment_state text not null default 'REQUIRES_ACTION'
    check (payment_state in ('REQUIRES_ACTION', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  terminal_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, game_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (expires_at > created_at),
  check ((state = 'ACTIVE' and terminal_at is null) or (state <> 'ACTIVE' and terminal_at is not null))
);

create unique index games_active_reservation_user_idx
  on games.seat_reservations (tenant_id, game_id, user_id)
  where state = 'ACTIVE';

create index games_reservation_expiry_idx
  on games.seat_reservations (tenant_id, expires_at, id)
  where state = 'ACTIVE';

create table games.waitlist_entries (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  position bigint not null check (position > 0),
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE', 'PROMOTED', 'LEFT', 'EXPIRED')),
  created_at timestamptz not null default now(),
  terminal_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, game_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check ((state = 'ACTIVE' and terminal_at is null) or (state <> 'ACTIVE' and terminal_at is not null))
);

create unique index games_active_waitlist_user_idx
  on games.waitlist_entries (tenant_id, game_id, user_id)
  where state = 'ACTIVE';

create unique index games_active_waitlist_position_idx
  on games.waitlist_entries (tenant_id, game_id, position)
  where state = 'ACTIVE';

create table games.result_submissions (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  revision integer not null default 1 check (revision > 0),
  submitted_by_user_id uuid not null,
  state text not null default 'PENDING_CONFIRMATION'
    check (state in ('PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED')),
  score_payload jsonb not null check (jsonb_typeof(score_payload) = 'object'),
  roster_snapshot jsonb not null check (jsonb_typeof(roster_snapshot) = 'object'),
  dispute_reason_code text check (
    dispute_reason_code is null or dispute_reason_code in (
      'SCORE_INCORRECT', 'ROSTER_INCORRECT', 'GAME_NOT_PLAYED', 'OTHER'
    )
  ),
  submitted_at timestamptz not null default now(),
  terminal_at timestamptz,
  primary key (tenant_id, game_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, submitted_by_user_id) references identity.users(tenant_id, id),
  check (
    (state = 'PENDING_CONFIRMATION' and terminal_at is null and dispute_reason_code is null)
    or (state = 'DISPUTED' and terminal_at is not null and dispute_reason_code is not null)
    or (state in ('CONFIRMED', 'SUPERSEDED') and terminal_at is not null and dispute_reason_code is null)
  )
);

create unique index games_active_result_submission_idx
  on games.result_submissions (tenant_id, game_id)
  where state in ('PENDING_CONFIRMATION', 'DISPUTED');

create table games.result_submission_reviews (
  tenant_id uuid not null,
  game_id uuid not null,
  submission_id uuid not null,
  reviewer_user_id uuid not null,
  decision text not null default 'PENDING' check (decision in ('PENDING', 'CONFIRMED', 'DISPUTED')),
  reason_code text check (
    reason_code is null or reason_code in ('SCORE_INCORRECT', 'ROSTER_INCORRECT', 'GAME_NOT_PLAYED', 'OTHER')
  ),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, submission_id, reviewer_user_id),
  foreign key (tenant_id, game_id, submission_id)
    references games.result_submissions(tenant_id, game_id, id),
  foreign key (tenant_id, reviewer_user_id) references identity.users(tenant_id, id),
  check (
    (decision = 'PENDING' and decided_at is null and reason_code is null)
    or (decision = 'CONFIRMED' and decided_at is not null and reason_code is null)
    or (decision = 'DISPUTED' and decided_at is not null and reason_code is not null)
  )
);

create table games.results (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  submission_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  state text not null default 'CONFIRMED' check (state in ('CONFIRMED', 'VOID')),
  score_payload jsonb not null check (jsonb_typeof(score_payload) = 'object'),
  confirmed_by_user_id uuid,
  confirmed_at timestamptz not null default now(),
  voided_at timestamptz,
  primary key (tenant_id, game_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, game_id, submission_id)
    references games.result_submissions(tenant_id, game_id, id),
  foreign key (tenant_id, confirmed_by_user_id) references identity.users(tenant_id, id),
  check ((state = 'CONFIRMED' and voided_at is null) or (state = 'VOID' and voided_at is not null))
);

create unique index games_active_result_idx
  on games.results (tenant_id, game_id)
  where state = 'CONFIRMED';

create table games.invitations (
  tenant_id uuid not null,
  game_id uuid not null,
  id uuid not null default gen_random_uuid(),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid not null,
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'REVOKED', 'EXPIRED', 'CONSUMED')),
  max_uses integer not null default 1 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, game_id, id),
  unique (tenant_id, token_hash),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  check (expires_at > created_at),
  check ((state = 'REVOKED' and revoked_at is not null) or (state <> 'REVOKED' and revoked_at is null))
);

create index games_active_invitation_idx
  on games.invitations (tenant_id, game_id, expires_at)
  where state = 'ACTIVE';

create table games.operations (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  game_id uuid not null,
  kind text not null check (kind in ('CREATE_GAME', 'PROVISION_BOOKING', 'CANCEL_GAME', 'RECONCILE')),
  state text not null default 'PENDING'
    check (state in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  requested_by_user_id uuid,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, requested_by_user_id) references identity.users(tenant_id, id),
  check (
    (state in ('PENDING', 'RUNNING') and completed_at is null)
    or (state in ('SUCCEEDED', 'FAILED', 'CANCELLED') and completed_at is not null)
  ),
  check ((state = 'FAILED' and error_code is not null) or state <> 'FAILED')
);

create index games_operations_active_idx
  on games.operations (tenant_id, state, created_at, id)
  where state in ('PENDING', 'RUNNING');

create table games.card_projections (
  tenant_id uuid not null,
  game_id uuid not null,
  aggregate_revision bigint not null check (aggregate_revision > 0),
  projection_revision bigint not null check (projection_revision > 0),
  lifecycle_state text not null
    check (lifecycle_state in ('SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED')),
  visibility text not null check (visibility in ('PUBLIC', 'PRIVATE', 'COMMUNITY')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  base_payload jsonb not null check (jsonb_typeof(base_payload) = 'object'),
  projected_at timestamptz not null default now(),
  primary key (tenant_id, game_id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  check (ends_at > starts_at)
);

create index games_card_discovery_idx
  on games.card_projections (tenant_id, starts_at, game_id)
  where lifecycle_state = 'SCHEDULED' and visibility = 'PUBLIC';

create table games.command_idempotency (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  actor_user_id uuid,
  principal_key text not null check (char_length(btrim(principal_key)) between 3 and 160),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  aggregate_id uuid,
  state text not null default 'IN_PROGRESS' check (state in ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  result_payload jsonb,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, aggregate_id) references games.games(tenant_id, id),
  unique (tenant_id, principal_key, idempotency_key),
  check (
    (state = 'IN_PROGRESS' and completed_at is null and result_payload is null and error_code is null)
    or (state = 'COMPLETED' and completed_at is not null and result_payload is not null and error_code is null)
    or (state = 'FAILED' and completed_at is not null and error_code is not null)
  ),
  check (actor_user_id is not null or principal_key like 'service:%')
);

create index games_command_aggregate_idx
  on games.command_idempotency (tenant_id, aggregate_id, created_at desc)
  where aggregate_id is not null;

create table games.scheduled_commands (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  game_id uuid not null,
  command_type text not null check (command_type in (
    'game.provisioning.advance.v1', 'game.reservation.expire.v1', 'game.waitlist.promote.v1',
    'game.lifecycle.start.v1', 'game.lifecycle.finish.v1',
    'game.integration.reconcile.v1'
  )),
  due_at timestamptz not null,
  expected_revision bigint check (expected_revision is null or expected_revision > 0),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  state text not null default 'PENDING' check (state in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text check (locked_by is null or char_length(btrim(locked_by)) between 1 and 160),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  check ((locked_at is null) = (locked_by is null)),
  check ((state = 'COMPLETED' and completed_at is not null) or (state <> 'COMPLETED' and completed_at is null))
);

create index games_scheduled_command_due_idx
  on games.scheduled_commands (due_at, available_at, tenant_id, id)
  where state in ('PENDING', 'FAILED');

alter table games.games enable row level security;
alter table games.participations enable row level security;
alter table games.seat_reservations enable row level security;
alter table games.waitlist_entries enable row level security;
alter table games.result_submissions enable row level security;
alter table games.result_submission_reviews enable row level security;
alter table games.results enable row level security;
alter table games.invitations enable row level security;
alter table games.operations enable row level security;
alter table games.card_projections enable row level security;
alter table games.command_idempotency enable row level security;
alter table games.scheduled_commands enable row level security;

create policy games_tenant_isolation on games.games
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_participations_tenant_isolation on games.participations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_seat_reservations_tenant_isolation on games.seat_reservations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_waitlist_entries_tenant_isolation on games.waitlist_entries
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_result_submissions_tenant_isolation on games.result_submissions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_result_submission_reviews_tenant_isolation on games.result_submission_reviews
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_results_tenant_isolation on games.results
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_invitations_tenant_isolation on games.invitations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_operations_tenant_isolation on games.operations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_card_projections_tenant_isolation on games.card_projections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_command_idempotency_tenant_isolation on games.command_idempotency
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy games_scheduled_commands_tenant_isolation on games.scheduled_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table games.games force row level security;
alter table games.participations force row level security;
alter table games.seat_reservations force row level security;
alter table games.waitlist_entries force row level security;
alter table games.result_submissions force row level security;
alter table games.result_submission_reviews force row level security;
alter table games.results force row level security;
alter table games.invitations force row level security;
alter table games.operations force row level security;
alter table games.card_projections force row level security;
alter table games.command_idempotency force row level security;
alter table games.scheduled_commands force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'games', 'LOCAL_PRIMARY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
