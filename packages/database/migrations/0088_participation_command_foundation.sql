-- Expand-only, default-off foundation for server-owned participation authorization.
-- No existing writer is routed through these tables by this migration.
-- phub:reviewed-new-table-index

create table eligibility.activity_level_projections (
  tenant_id uuid not null references identity.tenants(id),
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  activity_id uuid not null,
  sport_code text not null check (sport_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  constraint_mode text not null check (constraint_mode in ('NONE', 'RANGE')),
  min_level_id uuid,
  max_level_id uuid,
  constraint_source text not null check (constraint_source in (
    'CANONICAL',
    'LEGACY_GAME_SETTINGS',
    'LEGACY_TOURNAMENT_SETTINGS',
    'VIVA_EXERCISE',
    'LEGACY_ACCESS_LEVELS',
    'LEGACY_TEXT_FALLBACK'
  )),
  data_quality text not null check (data_quality in ('VALID', 'LEGACY', 'MISSING', 'INVALID')),
  scale_version integer check (scale_version is null or scale_version > 0),
  source_mapping_id uuid,
  source_revision bigint not null check (source_revision >= 0),
  projected_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, activity_type, activity_id),
  foreign key (tenant_id, sport_code, min_level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id),
  foreign key (tenant_id, sport_code, max_level_id)
    references eligibility.canonical_levels(tenant_id, sport_code, id),
  foreign key (tenant_id, source_mapping_id)
    references integration.external_entity_map(tenant_id, id),
  check (
    (constraint_mode = 'NONE' and min_level_id is null and max_level_id is null)
    or
    (constraint_mode = 'RANGE' and (
      (data_quality = 'VALID' and min_level_id is not null and max_level_id is not null
        and scale_version is not null)
      or
      (data_quality in ('LEGACY', 'MISSING', 'INVALID'))
    ))
  )
);

create unique index activity_level_projection_source_idx
  on eligibility.activity_level_projections (tenant_id, activity_type, source_mapping_id)
  where source_mapping_id is not null;

create table eligibility.participation_commands (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  principal_key text not null check (principal_key ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null,
  activity_type text not null check (activity_type in ('GAME', 'TOURNAMENT', 'TRAINING')),
  activity_id uuid not null,
  action text not null check (action in (
    'JOIN', 'JOIN_WAITLIST', 'PROMOTE_WAITLIST', 'BOOK', 'REGISTER', 'ADMIN_ADD'
  )),
  activity_source_revision bigint not null check (activity_source_revision >= 0),
  decision_id uuid not null,
  payment_snapshot_operation_id uuid,
  state text not null check (state in (
    'AUTHORIZED', 'REJECTED', 'APPLIED', 'FAILED', 'EXPIRED'
  )),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  authorization_expires_at timestamptz,
  acknowledgement_idempotency_key text,
  acknowledgement_request_hash text,
  writer_operation_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, principal_key, idempotency_key),
  unique (tenant_id, payment_snapshot_operation_id),
  unique (tenant_id, principal_key, writer_operation_id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, decision_id) references eligibility.decisions(tenant_id, id),
  foreign key (tenant_id, payment_snapshot_operation_id)
    references eligibility.payment_snapshots(tenant_id, operation_id),
  check (
    (state = 'AUTHORIZED' and authorization_expires_at is not null and completed_at is null
      and error_code is null)
    or
    (state = 'REJECTED' and authorization_expires_at is null and completed_at is not null
      and error_code is not null)
    or
    (state = 'APPLIED' and authorization_expires_at is not null and completed_at is not null
      and error_code is null)
    or
    (state in ('FAILED', 'EXPIRED') and authorization_expires_at is not null
      and completed_at is not null and error_code is not null)
  ),
  check (
    (acknowledgement_idempotency_key is null and acknowledgement_request_hash is null
      and writer_operation_id is null)
    or
    (char_length(acknowledgement_idempotency_key) between 8 and 200
      and acknowledgement_request_hash ~ '^[0-9a-f]{64}$'
      and writer_operation_id is not null)
  )
);

create index participation_commands_expiry_idx
  on eligibility.participation_commands (authorization_expires_at, tenant_id, id)
  where state = 'AUTHORIZED';

alter table eligibility.activity_level_projections enable row level security;
alter table eligibility.participation_commands enable row level security;

create policy eligibility_activity_level_projections_tenant_isolation
  on eligibility.activity_level_projections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy eligibility_participation_commands_tenant_isolation
  on eligibility.participation_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table eligibility.activity_level_projections force row level security;
alter table eligibility.participation_commands force row level security;
