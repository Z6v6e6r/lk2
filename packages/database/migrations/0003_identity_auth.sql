-- Expand-only identity persistence for the first authentication vertical.
-- Provider credentials and raw refresh tokens are deliberately not stored here.

create table if not exists identity.tenant_auth_config (
  tenant_id uuid primary key references identity.tenants(id),
  provider text not null check (provider in ('VIVA', 'LOCAL')),
  provider_tenant_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (provider = 'VIVA' and nullif(btrim(provider_tenant_key), '') is not null)
    or (provider = 'LOCAL' and provider_tenant_key is null)
  )
);

create table if not exists identity.users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table if not exists profile.user_summaries (
  tenant_id uuid not null,
  user_id uuid not null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  photo_url text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create table if not exists identity.external_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  provider text not null check (provider in ('VIVA', 'LOCAL')),
  issuer text not null check (char_length(btrim(issuer)) between 1 and 500),
  subject text not null check (char_length(btrim(subject)) between 1 and 500),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, issuer, subject),
  unique (tenant_id, user_id, issuer)
);

create table if not exists identity.refresh_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  family_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  parent_session_id uuid unique,
  replaced_by_session_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_session_id)
    references identity.refresh_sessions(tenant_id, id),
  foreign key (tenant_id, replaced_by_session_id)
    references identity.refresh_sessions(tenant_id, id),
  check (expires_at > created_at),
  check (
    (rotated_at is null and replaced_by_session_id is null)
    or (rotated_at is not null and replaced_by_session_id is not null)
  )
);

create index if not exists users_tenant_status_idx
  on identity.users (tenant_id, status);

create index if not exists external_identities_user_idx
  on identity.external_identities (tenant_id, user_id);

create index if not exists refresh_sessions_user_idx
  on identity.refresh_sessions (tenant_id, user_id, expires_at desc);

create index if not exists refresh_sessions_family_idx
  on identity.refresh_sessions (tenant_id, family_id);

insert into identity.tenant_auth_config (tenant_id, provider, provider_tenant_key)
select id, 'VIVA', 'iSkq6G'
from identity.tenants
where tenant_key = 'local-padel'
on conflict (tenant_id) do nothing;

alter table identity.tenant_auth_config enable row level security;
alter table identity.users enable row level security;
alter table profile.user_summaries enable row level security;
alter table identity.external_identities enable row level security;
alter table identity.refresh_sessions enable row level security;

create policy tenant_auth_config_tenant_isolation on identity.tenant_auth_config
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy users_tenant_isolation on identity.users
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy user_summaries_tenant_isolation on profile.user_summaries
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy external_identities_tenant_isolation on identity.external_identities
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy refresh_sessions_tenant_isolation on identity.refresh_sessions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table identity.tenant_auth_config force row level security;
alter table identity.users force row level security;
alter table profile.user_summaries force row level security;
alter table identity.external_identities force row level security;
alter table identity.refresh_sessions force row level security;
