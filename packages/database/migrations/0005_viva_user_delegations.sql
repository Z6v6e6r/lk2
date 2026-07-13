create schema if not exists legal;

create table if not exists integration.user_delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  provider text not null check (provider = 'VIVA'),
  issuer text not null check (char_length(btrim(issuer)) between 1 and 500),
  subject text not null check (char_length(btrim(subject)) between 1 and 500),
  refresh_token_ciphertext text not null check (char_length(refresh_token_ciphertext) > 0),
  encryption_key_version text not null check (char_length(btrim(encryption_key_version)) between 1 and 100),
  granted_scopes text[] not null default '{}',
  refresh_expires_at timestamptz,
  last_refreshed_at timestamptz,
  refresh_failed_at timestamptz,
  refresh_failure_code text,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, provider, issuer),
  unique (tenant_id, issuer, subject)
);

create index if not exists user_delegations_active_idx
  on integration.user_delegations (tenant_id, user_id, refresh_expires_at)
  where revoked_at is null;

create table if not exists legal.document_acceptances (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  document_kind text not null check (document_kind in ('PUBLIC_OFFER', 'PERSONAL_DATA_POLICY')),
  document_version text not null check (char_length(btrim(document_version)) between 1 and 100),
  accepted_at timestamptz not null default now(),
  correlation_id text not null,
  source text not null check (source in ('VIVA_OAUTH', 'PHONE_OTP')),
  primary key (tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, document_kind, document_version)
);

create index if not exists document_acceptances_current_idx
  on legal.document_acceptances (tenant_id, user_id, document_kind, accepted_at desc);

alter table integration.user_delegations enable row level security;
alter table legal.document_acceptances enable row level security;

create policy user_delegations_tenant_isolation on integration.user_delegations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy document_acceptances_tenant_isolation on legal.document_acceptances
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.user_delegations force row level security;
alter table legal.document_acceptances force row level security;
