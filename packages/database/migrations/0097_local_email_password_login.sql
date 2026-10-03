-- Expand only. No enrollment/backfill, grants, provider switch or credential/reset execution.
-- Login runtime is read-only over credentials; a future trusted email-proof writer owns enrollment.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table identity.local_email_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  email_key text not null check (
    char_length(email_key) between 3 and 254
    and email_key = lower(btrim(email_key))
    and email_key ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    and char_length(split_part(email_key, '@', 1)) <= 64
    and split_part(email_key, '@', 1) not like '.%'
    and split_part(email_key, '@', 1) not like '%.'
    and strpos(split_part(email_key, '@', 1), '..') = 0
  ),
  password_hash text not null check (
    password_hash ~ '^phub-scrypt-v1\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$'
  ),
  generation integer not null default 1 check (generation > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  email_verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, id, user_id),
  unique (tenant_id, user_id),
  unique (tenant_id, email_key)
);

create table identity.local_password_login_receipts (
  tenant_id uuid not null,
  command_key_hash text not null check (command_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  derivation_version text not null check (derivation_version = 'LOCAL_PASSWORD_V1'),
  user_id uuid not null,
  credential_id uuid not null,
  credential_generation integer not null check (credential_generation > 0),
  session_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, command_key_hash),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, credential_id, user_id) references identity.local_email_credentials(tenant_id, id, user_id),
  foreign key (tenant_id, session_id) references identity.refresh_sessions(tenant_id, id),
  check (expires_at > created_at)
);

-- Preserve receipt/session ownership without scanning/indexing all existing refresh sessions.
create function identity.check_local_password_receipt_session() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from identity.refresh_sessions
    where tenant_id = new.tenant_id and id = new.session_id and user_id = new.user_id
  ) then
    raise exception 'LOCAL_PASSWORD_RECEIPT_SESSION_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;
create constraint trigger local_password_receipt_session_owner
after insert or update on identity.local_password_login_receipts
for each row execute function identity.check_local_password_receipt_session();

-- A later ownership rewrite must not invalidate an already committed receipt either.
create function identity.protect_local_password_receipt_session_owner() returns trigger
language plpgsql as $$
begin
  -- Unconditional: do not rely on RLS-visible receipts or caller tenant context.
  raise exception 'LOCAL_PASSWORD_RECEIPT_SESSION_OWNER_IMMUTABLE' using errcode = '23514';
end;
$$;
create trigger local_password_session_owner_immutable
before update on identity.refresh_sessions
for each row
when (old.tenant_id is distinct from new.tenant_id or old.user_id is distinct from new.user_id or old.id is distinct from new.id)
execute function identity.protect_local_password_receipt_session_owner();

alter table identity.local_email_credentials enable row level security;
alter table identity.local_email_credentials force row level security;
create policy local_email_credentials_tenant_isolation on identity.local_email_credentials
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table identity.local_password_login_receipts enable row level security;
alter table identity.local_password_login_receipts force row level security;
create policy local_password_login_receipts_tenant_isolation on identity.local_password_login_receipts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
