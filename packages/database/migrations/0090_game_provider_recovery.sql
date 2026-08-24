-- Expand-only, default-off provider recovery journal for native Games.
-- Only the SYNTHETIC contract is representable until a real provider contract is proven.
-- phub:reviewed-new-table-index

set local lock_timeout = '5s';

create table integration.game_provider_operations (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  source_command_id uuid not null,
  action text not null check (action in ('JOIN_PAYMENT', 'PROMOTION_PAYMENT')),
  provider text not null check (provider = 'SYNTHETIC'),
  provider_contract_version text not null check (provider_contract_version = 'synthetic-v1'),
  provider_idempotency_key text not null check (char_length(provider_idempotency_key) between 16 and 200),
  correlation_id text not null check (char_length(correlation_id) between 8 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null,
  game_id uuid not null,
  reservation_id uuid not null,
  waitlist_entry_id uuid,
  eligibility_decision_id uuid not null,
  payment_snapshot_operation_id uuid not null,
  payment_mode text not null check (payment_mode in ('SPLIT', 'SUBSCRIPTION')),
  provider_exercise_id text check (provider_exercise_id is null or char_length(provider_exercise_id) between 1 and 200),
  expected_amount_minor bigint check (expected_amount_minor is null or expected_amount_minor >= 0),
  expected_currency text check (expected_currency is null or expected_currency ~ '^[A-Z]{3}$'),
  state text not null default 'READY' check (state in (
    'READY', 'SUBMITTING', 'UNKNOWN', 'RECONCILING', 'CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'
  )),
  resolution text check (resolution is null or resolution in ('ACCEPTED', 'REJECTED', 'UNKNOWN')),
  provider_operation_id text check (provider_operation_id is null or char_length(provider_operation_id) between 1 and 200),
  local_aggregate_revision bigint check (local_aggregate_revision is null or local_aggregate_revision > 0),
  submit_attempts smallint not null default 0 check (submit_attempts between 0 and 20),
  readback_attempts smallint not null default 0 check (readback_attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_class text check (last_error_class is null or last_error_class in (
    'TRANSIENT', 'NOT_SENT', 'AMBIGUOUS_EGRESS', 'PROVIDER_REJECTED',
    'ACTOR_MISMATCH', 'TENANT_MISMATCH', 'GAME_MISMATCH', 'PAYMENT_MISMATCH',
    'REFERENCE_MISMATCH', 'AMBIGUOUS_READBACK', 'READBACK_UNAVAILABLE', 'RETRY_EXHAUSTED'
  )),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  terminal_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, source_command_id, action),
  unique (tenant_id, provider, provider_idempotency_key),
  unique (tenant_id, provider, provider_operation_id),
  foreign key (tenant_id, source_command_id) references games.command_idempotency(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, game_id, reservation_id) references games.seat_reservations(tenant_id, game_id, id),
  foreign key (tenant_id, game_id, waitlist_entry_id) references games.waitlist_entries(tenant_id, game_id, id),
  foreign key (tenant_id, eligibility_decision_id) references eligibility.decisions(tenant_id, id),
  foreign key (tenant_id, payment_snapshot_operation_id)
    references eligibility.payment_snapshots(tenant_id, operation_id),
  check ((expected_amount_minor is null) = (expected_currency is null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (
    (state in ('SUBMITTING', 'RECONCILING') and lease_token is not null and terminal_at is null)
    or
    (state in ('READY', 'UNKNOWN') and lease_token is null and terminal_at is null and resolution is null)
    or
    (state = 'CONFIRMED' and lease_token is null and terminal_at is not null and resolution = 'ACCEPTED')
    or
    (state = 'REJECTED' and lease_token is null and terminal_at is not null and resolution = 'REJECTED')
    or
    (state = 'MANUAL_REVIEW' and lease_token is null and terminal_at is not null and resolution = 'UNKNOWN')
  ),
  check ((action = 'PROMOTION_PAYMENT') = (waitlist_entry_id is not null))
);

create index game_provider_operations_due_idx
  on integration.game_provider_operations (tenant_id, next_attempt_at, id)
  where state in ('READY', 'UNKNOWN');

create index game_provider_operations_expired_lease_idx
  on integration.game_provider_operations (tenant_id, lease_expires_at, id)
  where state in ('SUBMITTING', 'RECONCILING');

create index game_provider_operations_actor_lookup_idx
  on integration.game_provider_operations (tenant_id, actor_user_id, source_command_id);

create table integration.game_provider_operation_attempts (
  tenant_id uuid not null,
  operation_id uuid not null,
  id uuid not null default gen_random_uuid(),
  attempt_number smallint not null check (attempt_number between 1 and 20),
  phase text not null check (phase in ('SUBMIT', 'READBACK')),
  event_type text not null check (event_type in ('STARTED', 'FINISHED')),
  result_class text check (result_class is null or result_class in (
    'ACCEPTED', 'REJECTED', 'NOT_SENT', 'UNKNOWN', 'NOT_FOUND', 'MISMATCH', 'AMBIGUOUS', 'UNAVAILABLE'
  )),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  evidence_hash text check (evidence_hash is null or char_length(evidence_hash) between 1 and 256),
  error_class text check (error_class is null or error_class ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  started_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, operation_id, phase, attempt_number, event_type),
  foreign key (tenant_id, operation_id) references integration.game_provider_operations(tenant_id, id),
  check ((event_type = 'STARTED' and result_class is null and evidence_hash is null and error_class is null)
      or (event_type = 'FINISHED' and result_class is not null))
);

create index game_provider_operation_attempts_timeline_idx
  on integration.game_provider_operation_attempts (tenant_id, operation_id, started_at, recorded_at, id);

create table integration.game_provider_operation_observations (
  tenant_id uuid not null,
  operation_id uuid not null,
  id uuid not null default gen_random_uuid(),
  provider text not null check (provider = 'SYNTHETIC'),
  source text not null check (source in ('CALLBACK', 'READBACK', 'SYNCHRONOUS')),
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 256),
  normalized_result text not null check (normalized_result in (
    'ACCEPTED', 'REJECTED', 'NOT_FOUND', 'MISMATCH', 'AMBIGUOUS', 'UNAVAILABLE', 'DUPLICATE', 'STALE'
  )),
  match_result text not null check (match_result in (
    'MATCHED', 'ACTOR_MISMATCH', 'TENANT_MISMATCH', 'GAME_MISMATCH',
    'PAYMENT_MISMATCH', 'REFERENCE_MISMATCH', 'NOT_APPLICABLE'
  )),
  evidence_hash text not null check (char_length(evidence_hash) between 1 and 256),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, provider, dedupe_key),
  foreign key (tenant_id, operation_id) references integration.game_provider_operations(tenant_id, id)
);

create index game_provider_operation_observations_timeline_idx
  on integration.game_provider_operation_observations (tenant_id, operation_id, observed_at, id);

alter table integration.game_provider_operations enable row level security;
alter table integration.game_provider_operation_attempts enable row level security;
alter table integration.game_provider_operation_observations enable row level security;

create policy game_provider_operations_tenant_isolation
  on integration.game_provider_operations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy game_provider_operation_attempts_tenant_isolation
  on integration.game_provider_operation_attempts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy game_provider_operation_observations_tenant_isolation
  on integration.game_provider_operation_observations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.game_provider_operations force row level security;
alter table integration.game_provider_operation_attempts force row level security;
alter table integration.game_provider_operation_observations force row level security;
