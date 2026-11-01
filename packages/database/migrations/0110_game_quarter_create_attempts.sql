-- Expand-only private owner custody. Rollback retains all attempts/receipts.
-- No game, roster, payment or provider write is performed by this journal.
-- phub:reviewed-new-table-index
create table games.quarter_create_attempts (
 tenant_id uuid not null references identity.tenants(id), id uuid not null, draft_id uuid not null,
 actor_user_id uuid not null, key_sha256 text not null check(key_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 request_hash text not null check(request_hash ~ '^sha256:[a-f0-9]{64}$'),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<8192),
 context jsonb check(context is null or (jsonb_typeof(context)='object' and octet_length(context::text)<8192)),
 station_id uuid not null, court_id uuid not null, starts_at timestamptz not null,
 state text not null default 'PREPARING' check(state in ('PREPARING','PREPARED','DISPATCH_STARTED','CONFIRMED','REJECTED','EXPIRED_NOT_DISPATCHED','REFUSED_NOT_DISPATCHED')),
 admission jsonb check(admission is null or (jsonb_typeof(admission)='object' and octet_length(admission::text)<16384)),
 admission_hash text check(admission_hash is null or admission_hash ~ '^sha256:[a-f0-9]{64}$'),
 expires_at timestamptz, dispatch_started_at timestamptz, lease_token uuid, lease_until timestamptz,
 receipt jsonb check(receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<16384)),
 game_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,draft_id), unique(tenant_id,actor_user_id,key_sha256),
 foreign key(tenant_id,id) references games.command_idempotency(tenant_id,id),
 check(context is not null or state='REFUSED_NOT_DISPATCHED'),
 foreign key(tenant_id,actor_user_id) references identity.users(tenant_id,id),
 foreign key(tenant_id,station_id) references locations.profiles(tenant_id,id),
 foreign key(tenant_id,game_id) references games.games(tenant_id,id),
 check((lease_token is null)=(lease_until is null)),
 check((admission is null)=(admission_hash is null) and (admission is null)=(expires_at is null)),
 check((state in ('PREPARING','REFUSED_NOT_DISPATCHED'))=(admission is null)),
 check((state in ('DISPATCH_STARTED','CONFIRMED','REJECTED'))=(dispatch_started_at is not null)),
 check((state in ('CONFIRMED','REJECTED'))=(receipt is not null)),
 check(game_id is null or state='CONFIRMED'),
 check(lease_token is null or state in ('PREPARING','DISPATCH_STARTED'))
);
-- Failed or lost dispatched work keeps the slot. Only exact terminal proof frees it.
create unique index quarter_create_actor_window_idx on games.quarter_create_attempts(tenant_id,actor_user_id,court_id,starts_at)
 where state not in ('REJECTED','EXPIRED_NOT_DISPATCHED','REFUSED_NOT_DISPATCHED');
alter table games.quarter_create_attempts enable row level security;
alter table games.quarter_create_attempts force row level security;
create policy quarter_create_attempts_tenant_isolation on games.quarter_create_attempts
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
