-- Expand-only reusable DIRECT invite aggregate. Raw invite tokens are derived by
-- the application from a dedicated secret and never cross this persistence boundary.

create table if not exists communities.direct_invites (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  community_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_key_id text not null check (token_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  issued_by_user_id uuid not null,
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE', 'REVOKED', 'EXPIRED')),
  revision bigint not null default 1 check (revision > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, token_hash),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, issued_by_user_id)
    references identity.users(tenant_id, id),
  check (expires_at > created_at),
  check (
    (state = 'REVOKED' and revoked_at is not null)
    or (state <> 'REVOKED' and revoked_at is null)
  )
);

create index if not exists community_direct_invites_active_idx
  on communities.direct_invites (tenant_id, community_id, created_at desc, id desc)
  where state = 'ACTIVE';

create index if not exists community_direct_invites_issuer_idx
  on communities.direct_invites (tenant_id, issued_by_user_id, created_at desc, id desc);

create index if not exists community_direct_invites_due_expiry_idx
  on communities.direct_invites (tenant_id, expires_at, id)
  where state = 'ACTIVE';

create table if not exists communities.direct_invite_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type in ('ISSUE', 'REDEEM', 'REVOKE')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  invite_id uuid not null,
  subject_user_id uuid,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, invite_id)
    references communities.direct_invites(tenant_id, id),
  foreign key (tenant_id, subject_user_id)
    references identity.users(tenant_id, id),
  check (
    (command_type = 'REDEEM' and subject_user_id is not null)
    or (command_type <> 'REDEEM' and subject_user_id is null)
  )
);

create index if not exists community_direct_invite_commands_invite_idx
  on communities.direct_invite_commands (tenant_id, invite_id, created_at desc);

alter table communities.direct_invites enable row level security;
alter table communities.direct_invite_commands enable row level security;

create policy community_direct_invites_tenant_isolation
  on communities.direct_invites
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_direct_invite_commands_tenant_isolation
  on communities.direct_invite_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.direct_invites force row level security;
alter table communities.direct_invite_commands force row level security;
