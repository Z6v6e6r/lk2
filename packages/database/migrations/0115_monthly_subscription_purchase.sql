-- Expand-only commerce custody. Rollback closes admission and retains this journal.
-- Owner remains VIVA_PRIMARY; this table records intent/receipt, not entitlement.
-- phub:reviewed-new-table-index
create table commerce.monthly_purchase_attempts (
 tenant_id uuid not null references identity.tenants(id), id uuid not null,
 actor_user_id uuid not null, originating_session_id uuid not null,
 key_sha256 text not null check(key_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 offer_id uuid not null check(offer_id='862670f6-a476-4a18-aecb-9e27661fbad3'),
 provider_client_id text not null check(char_length(provider_client_id) between 1 and 200),
 provider_mapping_id uuid not null,
 state text not null default 'QUOTING' check(state in ('QUOTING','QUOTED','DISPATCH_STARTED','UNKNOWN','PAYMENT_PENDING','PAID')),
 quote jsonb check(quote is null or (jsonb_typeof(quote)='object' and octet_length(quote::text)<8192)),
 quote_expires_at timestamptz,
 consent jsonb check(consent is null or (jsonb_typeof(consent)='object' and octet_length(consent::text)<4096)),
 consent_hash text check(consent_hash is null or consent_hash ~ '^sha256:[a-f0-9]{64}$'),
 dispatch_started_at timestamptz,
 receipt jsonb check(receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<8192)),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,actor_user_id,key_sha256),
 foreign key(tenant_id,actor_user_id) references identity.users(tenant_id,id),
 foreign key(tenant_id,provider_mapping_id) references integration.external_entity_map(tenant_id,id),
 foreign key(tenant_id,originating_session_id) references identity.refresh_sessions(tenant_id,id),
 check((quote is null)=(state='QUOTING')),
 check((quote is null)=(quote_expires_at is null)),
 check((state in ('QUOTING','QUOTED'))=(dispatch_started_at is null)),
 check((dispatch_started_at is null)=(consent is null) and (consent is null)=(consent_hash is null)),
 check(receipt is null or dispatch_started_at is not null),
 check(state not in ('PAYMENT_PENDING','PAID') or receipt is not null)
);
-- Ambiguous work retains its slot; elapsed time does not authorize a new payment.
create unique index monthly_purchase_active_actor_idx on commerce.monthly_purchase_attempts(tenant_id,actor_user_id)
 where state in ('DISPATCH_STARTED','UNKNOWN','PAYMENT_PENDING');
create unique index monthly_purchase_transaction_idx on commerce.monthly_purchase_attempts(tenant_id,(receipt->>'providerTransactionId'))
 where receipt->>'providerTransactionId' is not null;
create unique index monthly_purchase_instance_idx on commerce.monthly_purchase_attempts(tenant_id,(receipt->>'providerSubscriptionId'))
 where receipt->>'providerSubscriptionId' is not null;
alter table commerce.monthly_purchase_attempts enable row level security;
alter table commerce.monthly_purchase_attempts force row level security;
create policy monthly_purchase_tenant_isolation on commerce.monthly_purchase_attempts
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- One-use navigation capability. Only its hash is retained; no bank URL/token here.
-- phub:reviewed-new-table-index
create table commerce.monthly_purchase_launches (
 tenant_id uuid not null references identity.tenants(id), id uuid not null,
 operation_id uuid not null, actor_user_id uuid not null, session_id uuid not null,
 code_hash text not null check(code_hash ~ '^sha256:[a-f0-9]{64}$'),
 expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(code_hash),
 foreign key(tenant_id,operation_id) references commerce.monthly_purchase_attempts(tenant_id,id),
 foreign key(tenant_id,actor_user_id) references identity.users(tenant_id,id),
 foreign key(tenant_id,session_id) references identity.refresh_sessions(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '60 seconds')
);
create index monthly_purchase_launch_operation_idx on commerce.monthly_purchase_launches(tenant_id,operation_id,actor_user_id);
alter table commerce.monthly_purchase_launches enable row level security;
alter table commerce.monthly_purchase_launches force row level security;
create policy monthly_purchase_launch_tenant_isolation on commerce.monthly_purchase_launches
 using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
