-- Expand-only concrete managed FREE SELF LEAVE journal. Integrate after frozen 0105.
-- No backfill, provider access or change to historical paid JOIN/eligibility evidence.
-- Rollback disables new admission; retain this table and immutable terminal receipts.
-- phub:reviewed-new-table-index
create table games.managed_self_leave_attempts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null,
  game_id uuid not null,
  user_id uuid not null,
  participation_id uuid not null,
  reservation_id uuid not null,
  eligibility_decision_id uuid not null,
  evidence_id uuid not null,
  join_operation_id uuid not null,
  authority jsonb not null check (jsonb_typeof(authority) = 'object' and octet_length(authority::text) <= 16384),
  binding_sha256 text not null check (binding_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  state text not null default 'PREPARED' check (state in ('PREPARED','DISPATCH_STARTED','COMPLETED')),
  dispatch_started_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  receipt jsonb check (receipt is null or (jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 16384)),
  receipt_sha256 text check (receipt_sha256 is null or receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,id),
  unique (tenant_id,participation_id),
  foreign key (tenant_id,id) references games.command_idempotency(tenant_id,id),
  foreign key (tenant_id,game_id) references games.games(tenant_id,id),
  foreign key (tenant_id,user_id) references identity.users(tenant_id,id),
  foreign key (tenant_id,game_id,participation_id) references games.participations(tenant_id,game_id,id),
  foreign key (tenant_id,game_id,reservation_id) references games.seat_reservations(tenant_id,game_id,id),
  foreign key (tenant_id,eligibility_decision_id) references eligibility.decisions(tenant_id,id),
  foreign key (tenant_id,evidence_id) references games.payment_confirmation_evidence(tenant_id,id),
  foreign key (tenant_id,join_operation_id) references eligibility.payment_snapshots(tenant_id,operation_id),
  check ((lease_token is null) = (lease_until is null)),
  check (lease_until is null or lease_until > created_at),
  check (
    (state = 'PREPARED' and dispatch_started_at is null and lease_token is null and receipt is null and receipt_sha256 is null and completed_at is null)
    or (state = 'DISPATCH_STARTED' and dispatch_started_at is not null and receipt is null and receipt_sha256 is null and completed_at is null)
    or (state = 'COMPLETED' and dispatch_started_at is not null and lease_token is null and receipt is not null and receipt_sha256 is not null and completed_at is not null)
  )
);
create index games_managed_self_leave_actor_idx on games.managed_self_leave_attempts (tenant_id,user_id,game_id,created_at desc,id);
alter table games.managed_self_leave_attempts enable row level security;
create policy games_managed_self_leave_attempts_tenant_isolation on games.managed_self_leave_attempts
  using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table games.managed_self_leave_attempts force row level security;

-- Concrete same-participation idempotency convergence; aliases never dispatch an owner command.
create table games.managed_self_leave_command_links (
  tenant_id uuid not null references identity.tenants(id),
  command_id uuid not null,
  attempt_id uuid not null,
  primary key (tenant_id,command_id),
  foreign key (tenant_id,command_id) references games.command_idempotency(tenant_id,id),
  foreign key (tenant_id,attempt_id) references games.managed_self_leave_attempts(tenant_id,id)
);
create index games_managed_self_leave_links_attempt_idx on games.managed_self_leave_command_links(tenant_id,attempt_id);
alter table games.managed_self_leave_command_links enable row level security;
create policy games_managed_self_leave_links_tenant_isolation on games.managed_self_leave_command_links
  using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table games.managed_self_leave_command_links force row level security;
