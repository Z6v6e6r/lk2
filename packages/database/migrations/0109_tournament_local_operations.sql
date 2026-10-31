-- Concrete CUP LOCAL_ONLY command custody, not a second roster. Expand after0108.
-- Retain journal and receipts on rollback; no backfill, provider call or startup migration.
set lock_timeout = '5s';
set statement_timeout = '30s';
-- phub:reviewed-new-table-index
create table booking.tournament_local_attempts (
 tenant_id uuid not null references identity.tenants(id), id uuid not null,
 actor_user_id uuid not null, tournament_id uuid not null,
 key_sha256 text not null check(key_sha256 ~ '^[a-f0-9]{64}$'),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=1024),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 owner_command jsonb not null check(jsonb_typeof(owner_command)='object' and octet_length(owner_command::text)<=1024),
 authority_hash text not null check(authority_hash ~ '^[a-f0-9]{64}$'),
 owner_operation_id uuid not null, provider_tenant_key text not null,
 provider_client_id text not null, provider_mapping_id uuid not null,
 original_join_id uuid,
 state text not null check(state in ('READY','DISPATCHED','COMPLETED')),
 lease_token uuid, lease_until timestamptz, dispatch_started_at timestamptz,
 receipt jsonb check(receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=4096)),
 receipt_hash text check(receipt_hash is null or receipt_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,id,actor_user_id,tournament_id),
 unique(tenant_id,actor_user_id,key_sha256),
 foreign key(tenant_id,actor_user_id) references identity.users(tenant_id,id),
 foreign key(tenant_id,original_join_id,actor_user_id,tournament_id) references booking.tournament_local_attempts(tenant_id,id,actor_user_id,tournament_id),
 check((lease_token is null)=(lease_until is null)),
 check((receipt is null)=(receipt_hash is null)),
 check((state='COMPLETED')=(receipt is not null)),
 check(state<>'READY' or dispatch_started_at is null),
 check(state='READY' or dispatch_started_at is not null),
 check(state<>'COMPLETED' or lease_token is null)
);
create unique index tournament_local_pending_actor_target on booking.tournament_local_attempts(tenant_id,actor_user_id,tournament_id) where state<>'COMPLETED';
alter table booking.tournament_local_attempts enable row level security;
create policy tournament_local_tenant on booking.tournament_local_attempts
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table booking.tournament_local_attempts force row level security;
reset lock_timeout;
reset statement_timeout;
