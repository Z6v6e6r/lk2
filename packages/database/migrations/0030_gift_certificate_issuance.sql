-- Expand-only certificate issuance, private PDF artifact and delivery journal.
-- Activation and credit spending remain separate commands and are not introduced here.

create table gift_certificates.certificates (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  certificate_number text not null check (certificate_number ~ '^PH-GC-[A-Z0-9]{16}$'),
  status text not null default 'PREPARING' check (status in ('PREPARING', 'ISSUED', 'VOIDED')),
  activation_token_digest text not null check (activation_token_digest ~ '^[0-9a-f]{64}$'),
  amount_minor bigint not null check (amount_minor between 10000 and 100000000),
  currency text not null check (currency = 'RUB'),
  validity_start text not null check (validity_start in ('ISSUE', 'ACTIVATION')),
  validity_days integer not null check (validity_days between 1 and 3650),
  activation_deadline_days integer check (activation_deadline_days between 1 and 3650),
  activation_deadline_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, order_id),
  unique (tenant_id, certificate_number),
  unique (tenant_id, activation_token_digest),
  foreign key (tenant_id, order_id) references gift_certificates.orders(tenant_id, id),
  check (
    (status = 'PREPARING' and issued_at is null)
    or (status in ('ISSUED', 'VOIDED') and issued_at is not null)
  ),
  check (
    (validity_start = 'ISSUE' and activation_deadline_days is null and activation_deadline_at is null)
    or (validity_start = 'ACTIVATION' and activation_deadline_days is not null)
  ),
  check (
    (validity_start = 'ISSUE' and status = 'PREPARING' and valid_from is null and valid_until is null)
    or
    (validity_start = 'ISSUE' and status in ('ISSUED', 'VOIDED')
      and valid_from is not null and valid_until is not null and valid_until > valid_from)
    or
    (validity_start = 'ACTIVATION' and valid_from is null and valid_until is null)
  )
);

create table gift_certificates.artifacts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  certificate_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'READY')),
  object_key text,
  content_sha256 text,
  content_type text,
  byte_size integer,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, certificate_id),
  unique (tenant_id, object_key),
  foreign key (tenant_id, certificate_id)
    references gift_certificates.certificates(tenant_id, id),
  check (
    (status = 'PENDING' and object_key is null and content_sha256 is null
      and content_type is null and byte_size is null and generated_at is null)
    or
    (status = 'READY'
      and object_key ~ '^gift-certificates/[0-9a-f-]{36}/[0-9a-f]{64}\.pdf$'
      and content_sha256 ~ '^[0-9a-f]{64}$'
      and content_type = 'application/pdf'
      and byte_size between 1024 and 8388608
      and generated_at is not null)
  )
);

create table gift_certificates.deliveries (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  certificate_id uuid not null,
  channel text not null check (channel = 'EMAIL'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SANDBOXED', 'DELIVERED', 'FAILED')),
  recipient_email text not null check (char_length(btrim(recipient_email)) between 3 and 320),
  available_at timestamptz not null,
  next_attempt_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  last_error_code text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, certificate_id, channel),
  foreign key (tenant_id, certificate_id)
    references gift_certificates.certificates(tenant_id, id),
  check (
    (status = 'PENDING' and delivered_at is null)
    or (status in ('SANDBOXED', 'DELIVERED') and delivered_at is not null)
    or (status = 'FAILED' and delivered_at is null)
  )
);

create index gift_certificate_delivery_due_idx
  on gift_certificates.deliveries (tenant_id, next_attempt_at, id)
  where status = 'PENDING';

alter table gift_certificates.certificates enable row level security;
alter table gift_certificates.artifacts enable row level security;
alter table gift_certificates.deliveries enable row level security;

create policy gift_certificate_certificates_tenant_isolation
  on gift_certificates.certificates
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_artifacts_tenant_isolation
  on gift_certificates.artifacts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_deliveries_tenant_isolation
  on gift_certificates.deliveries
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gift_certificates.certificates force row level security;
alter table gift_certificates.artifacts force row level security;
alter table gift_certificates.deliveries force row level security;
