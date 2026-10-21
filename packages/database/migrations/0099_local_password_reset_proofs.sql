-- Expand only: empty proof/receipt ledgers. No enrollment, grant or runtime activation.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table identity.local_password_reset_proofs (
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  credential_id uuid not null,
  credential_generation integer not null check (credential_generation > 0),
  purpose text not null default 'RESET_LOCAL_CREDENTIAL' check (purpose = 'RESET_LOCAL_CREDENTIAL'),
  command_key_hash text not null check (command_key_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'DELIVERED', 'CONSUMED', 'CANCELLED', 'BLOCKED')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  delivered_at timestamptz,
  consumed_at timestamptz,
  foreign key (tenant_id, credential_id, user_id) references identity.local_email_credentials(tenant_id, id, user_id),
  unique (tenant_id, command_key_hash),
  unique (tenant_id, id),
  unique (tenant_id, id, user_id, credential_id, credential_generation, command_key_hash),
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check (status not in ('DELIVERED', 'CONSUMED') or delivered_at is not null),
  check ((status = 'CONSUMED') = (consumed_at is not null)),
  check (status <> 'BLOCKED' or attempts = 5)
);
-- phub:reviewed-new-table-index
-- Empty additive table only; bounds issuance/cooldown scans for one account.
create index local_password_reset_proofs_account_time_idx
  on identity.local_password_reset_proofs (tenant_id, user_id, created_at);

create table identity.local_password_reset_receipts (
  tenant_id uuid not null,
  command_key_hash text not null,
  proof_id uuid not null,
  user_id uuid not null,
  credential_id uuid not null,
  credential_generation integer not null,
  resulting_generation integer not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, command_key_hash),
  unique (tenant_id, proof_id),
  foreign key (tenant_id, proof_id, user_id, credential_id, credential_generation, command_key_hash)
    references identity.local_password_reset_proofs(tenant_id, id, user_id, credential_id, credential_generation, command_key_hash),
  check (resulting_generation::bigint = credential_generation::bigint + 1)
);

alter table identity.local_password_reset_proofs enable row level security;
alter table identity.local_password_reset_proofs force row level security;
create policy local_password_reset_proofs_tenant_isolation on identity.local_password_reset_proofs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table identity.local_password_reset_receipts enable row level security;
alter table identity.local_password_reset_receipts force row level security;
create policy local_password_reset_receipts_tenant_isolation on identity.local_password_reset_receipts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
