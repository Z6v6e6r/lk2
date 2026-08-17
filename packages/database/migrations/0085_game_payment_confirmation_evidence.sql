-- Expand-only journal for trusted provider payment confirmations.
-- A confirmation uses the participation eligibility snapshot captured at reservation time.
-- phub:reviewed-new-table-index

create table games.payment_confirmation_evidence (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  game_id uuid not null,
  reservation_id uuid not null,
  user_id uuid not null,
  eligibility_decision_id uuid not null,
  provider text not null check (provider in ('VIVA')),
  provider_operation_type text not null
    check (provider_operation_type in ('TRANSACTION', 'SUBSCRIPTION_BOOKING')),
  provider_operation_id text not null
    check (char_length(btrim(provider_operation_id)) between 1 and 200),
  provider_booking_id text not null
    check (char_length(btrim(provider_booking_id)) between 1 and 200),
  client_phone_e164 text not null check (client_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  payment_mode text not null check (payment_mode in ('SPLIT', 'SUBSCRIPTION')),
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  verified_by text not null check (verified_by in ('LEGACY_NODE_RED')),
  resolution text not null default 'RECEIVED'
    check (resolution in ('RECEIVED', 'APPLIED', 'REJECTED')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  participation_id uuid,
  aggregate_revision bigint check (aggregate_revision is null or aggregate_revision > 0),
  received_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, game_id, reservation_id)
    references games.seat_reservations(tenant_id, game_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, eligibility_decision_id)
    references eligibility.decisions(tenant_id, id),
  foreign key (tenant_id, game_id, participation_id)
    references games.participations(tenant_id, game_id, id),
  unique (tenant_id, provider, provider_operation_type, provider_operation_id),
  unique (tenant_id, reservation_id),
  check (
    (resolution = 'RECEIVED' and error_code is null and participation_id is null
      and aggregate_revision is null and resolved_at is null)
    or (resolution = 'APPLIED' and error_code is null and participation_id is not null
      and aggregate_revision is not null and resolved_at is not null)
    or (resolution = 'REJECTED' and error_code is not null and participation_id is null
      and aggregate_revision is not null and resolved_at is not null)
  )
);

create index games_payment_confirmation_game_timeline_idx
  on games.payment_confirmation_evidence (tenant_id, game_id, received_at desc, id);

alter table games.payment_confirmation_evidence enable row level security;

create policy games_payment_confirmation_evidence_tenant_isolation
  on games.payment_confirmation_evidence
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table games.payment_confirmation_evidence force row level security;
