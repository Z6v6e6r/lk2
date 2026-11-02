-- Concrete nonmonetary training owner journal; expand-only, default-off consumer.
-- Retain all attempts on rollback. No migration/backfill/provider execution on startup.
-- phub:reviewed-new-table-index
create table booking.training_registration_attempts (
 tenant_id uuid not null references identity.tenants(id),
 id uuid not null,
 actor_user_id uuid not null,
 training_id uuid not null,
 subscription_id uuid not null,
 date_hint date not null,
 key_sha256 text not null check (key_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 public_request_hash text not null check (public_request_hash ~ '^sha256:[a-f0-9]{64}$'),
 authority jsonb check (jsonb_typeof(authority)='object' and octet_length(authority::text)<=16384),
 authority_sha256 text check (authority_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 preparation_expires_at timestamptz,
 state text not null default 'PREPARING' check(state in ('PREPARING','PREPARED','DISPATCH_STARTED','CONFIRMED','EXPIRED_NOT_DISPATCHED','REJECTED_NOT_DISPATCHED')),
 dispatch_started_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 receipt jsonb check(receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=16384)),
 receipt_sha256 text check(receipt_sha256 is null or receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(tenant_id,id),
 unique(tenant_id,actor_user_id,key_sha256),
 foreign key(tenant_id,actor_user_id) references identity.users(tenant_id,id),
 check((lease_token is null)=(lease_until is null)),
 check(lease_until is null or lease_until>created_at),
 check ((authority is null)=(authority_sha256 is null)),
 check ((authority is null)=(preparation_expires_at is null)),
 check ((state in ('PREPARING','REJECTED_NOT_DISPATCHED'))=(authority is null)),
 check(
  (state='PREPARING' and dispatch_started_at is null and receipt is null and receipt_sha256 is null and completed_at is null)
  or(state='REJECTED_NOT_DISPATCHED' and dispatch_started_at is null and lease_token is null and receipt is null and receipt_sha256 is null and completed_at is not null)
  or(state='PREPARED' and dispatch_started_at is null and lease_token is null and receipt is null and receipt_sha256 is null and completed_at is null)
  or(state='DISPATCH_STARTED' and dispatch_started_at is not null and receipt is null and receipt_sha256 is null and completed_at is null)
  or(state='CONFIRMED' and dispatch_started_at is not null and lease_token is null and receipt is not null and receipt_sha256 is not null and completed_at is not null)
  or(state='EXPIRED_NOT_DISPATCHED' and dispatch_started_at is null and lease_token is null and receipt is null and receipt_sha256 is null and completed_at is not null)
 )
);
-- Only serialized PREPARED expiry or exact PREPARING refusal releases this fence.
-- Unknown/attempted/confirmed operations keep it, until a real leave generation contract exists.
create unique index training_registration_actor_target_idx
 on booking.training_registration_attempts(tenant_id,actor_user_id,training_id)
 where state not in ('EXPIRED_NOT_DISPATCHED','REJECTED_NOT_DISPATCHED');
alter table booking.training_registration_attempts enable row level security;
create policy training_registration_attempts_tenant_isolation on booking.training_registration_attempts
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table booking.training_registration_attempts force row level security;
