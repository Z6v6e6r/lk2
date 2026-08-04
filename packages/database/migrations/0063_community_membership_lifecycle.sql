-- Expand-only durable workflow for canonical community membership lifecycle.
-- User and CUP commands mutate Communities-owned state only through the API;
-- every applied command is committed with audit and outbox in one transaction.

alter table communities.memberships
  add constraint community_inactive_members_are_members_check
    check (status = 'ACTIVE' or role = 'MEMBER') not valid,
  add constraint community_only_active_members_can_pin_check
    check (status = 'ACTIVE' or pinned_at is null) not valid,
  add constraint community_active_members_have_no_left_at_check
    check (status <> 'ACTIVE' or left_at is null) not valid;

create table if not exists communities.join_requests (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  community_id uuid not null,
  user_id uuid not null,
  request_kind text not null check (request_kind in ('JOIN', 'REJOIN')),
  origin_status text not null check (origin_status in ('ABSENT', 'LEFT', 'REMOVED')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  revision bigint not null default 1 check (revision > 0),
  requested_by uuid not null,
  decided_by uuid,
  decision_reason_code text check (
    decision_reason_code is null
    or decision_reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, requested_by)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, decided_by)
    references identity.users(tenant_id, id),
  check (
    (status = 'PENDING' and decided_by is null and decided_at is null)
    or (status <> 'PENDING' and decided_at is not null)
  )
);

create unique index if not exists community_one_pending_join_request_idx
  on communities.join_requests (tenant_id, community_id, user_id)
  where status = 'PENDING';

create index if not exists community_pending_join_requests_queue_idx
  on communities.join_requests (tenant_id, requested_at, id)
  where status = 'PENDING';

create index if not exists community_join_requests_user_history_idx
  on communities.join_requests (tenant_id, user_id, requested_at desc, id desc);

create table if not exists communities.membership_lifecycle_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  subject_user_id uuid not null,
  command_type text not null
    check (command_type in ('JOIN', 'CANCEL_JOIN_REQUEST', 'LEAVE', 'DECIDE_JOIN_REQUEST')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, subject_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create index if not exists community_membership_lifecycle_commands_aggregate_idx
  on communities.membership_lifecycle_commands (
    tenant_id,
    community_id,
    subject_user_id,
    created_at desc
  );

alter table communities.join_requests enable row level security;
alter table communities.membership_lifecycle_commands enable row level security;

create policy community_join_requests_tenant_isolation
  on communities.join_requests
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_membership_lifecycle_commands_tenant_isolation
  on communities.membership_lifecycle_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.join_requests force row level security;
alter table communities.membership_lifecycle_commands force row level security;

create index if not exists community_membership_lifecycle_lookup_idx
  on communities.memberships (tenant_id, community_id, user_id, status, revision);
