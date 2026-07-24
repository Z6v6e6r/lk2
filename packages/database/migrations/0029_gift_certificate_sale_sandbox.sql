-- Expand-only gift certificate sale foundation and local payment sandbox journal.
-- Certificate issuance, delivery, activation and credit spending remain disabled.

alter table gift_certificates.designs
  drop constraint if exists designs_image_url_check;

alter table gift_certificates.designs
  add constraint designs_image_url_check check (
    char_length(image_url) <= 2000
    and (
      image_url ~ '^https://'
      or image_url ~ '^/public/api/v1/[a-z0-9][a-z0-9-]{1,62}/gift-certificate-media/[0-9a-f-]{36}$'
    )
  );

create table gift_certificates.media_assets (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  status text not null check (status in ('READY', 'REJECTED')),
  object_key text not null check (
    object_key ~ '^gift-certificate-media/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null check (content_type = 'image/webp'),
  byte_size integer not null check (byte_size between 1 and 8388608),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, content_sha256),
  unique (tenant_id, object_key),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id)
);

create table gift_certificates.purchase_sessions (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, secret_hash),
  check (expires_at > created_at)
);

create table gift_certificates.media_commands (
  tenant_id uuid not null references identity.tenants(id),
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, asset_id) references gift_certificates.media_assets(tenant_id, id)
);

create index gift_certificate_purchase_session_expiry_idx
  on gift_certificates.purchase_sessions (tenant_id, expires_at, id);

create table gift_certificates.orders (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  order_number text not null check (order_number ~ '^GC-[A-Z0-9]{12}$'),
  sales_channel text not null check (sales_channel in ('PUBLIC_WEB', 'LK')),
  buyer_user_id uuid,
  purchase_session_id uuid,
  buyer_email text not null check (char_length(btrim(buyer_email)) between 3 and 320),
  recipient_name text not null check (char_length(btrim(recipient_name)) between 1 and 120),
  recipient_email text not null check (char_length(btrim(recipient_email)) between 3 and 320),
  recipient_message text check (
    recipient_message is null or char_length(btrim(recipient_message)) between 1 and 500
  ),
  delivery_mode text not null check (delivery_mode in ('IMMEDIATE', 'SCHEDULED')),
  scheduled_for timestamptz,
  catalog_id uuid not null,
  catalog_number integer not null check (catalog_number > 0),
  design_id uuid not null,
  denomination_id uuid not null,
  design_snapshot jsonb not null check (jsonb_typeof(design_snapshot) = 'object'),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot) = 'object'),
  amount_minor bigint not null check (amount_minor between 10000 and 100000000),
  currency text not null check (currency = 'RUB'),
  status text not null default 'PAYMENT_PENDING'
    check (status in ('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'CANCELLED')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, order_number),
  foreign key (tenant_id, buyer_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, purchase_session_id)
    references gift_certificates.purchase_sessions(tenant_id, id),
  foreign key (tenant_id, catalog_id)
    references gift_certificates.catalog_versions(tenant_id, id),
  foreign key (tenant_id, design_id)
    references gift_certificates.designs(tenant_id, id),
  foreign key (tenant_id, denomination_id)
    references gift_certificates.denominations(tenant_id, id),
  check (
    (sales_channel = 'LK' and buyer_user_id is not null and purchase_session_id is null)
    or
    (sales_channel = 'PUBLIC_WEB' and buyer_user_id is null and purchase_session_id is not null)
  ),
  check (
    (delivery_mode = 'IMMEDIATE' and scheduled_for is null)
    or (delivery_mode = 'SCHEDULED' and scheduled_for is not null)
  ),
  check (
    (status = 'PAID' and paid_at is not null)
    or (status <> 'PAID' and paid_at is null)
  )
);

create index gift_certificate_orders_buyer_idx
  on gift_certificates.orders (tenant_id, buyer_user_id, created_at desc, id desc)
  where buyer_user_id is not null;

create index gift_certificate_orders_purchase_session_idx
  on gift_certificates.orders (tenant_id, purchase_session_id, created_at desc, id desc)
  where purchase_session_id is not null;

create table commerce.payment_operations (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  provider text not null check (provider = 'PADLHUB_SANDBOX'),
  status text not null default 'PENDING' check (status in ('PENDING', 'CONFIRMED', 'FAILED')),
  amount_minor bigint not null check (amount_minor between 10000 and 100000000),
  currency text not null check (currency = 'RUB'),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  failed_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, order_id),
  foreign key (tenant_id, order_id) references gift_certificates.orders(tenant_id, id),
  check (
    (status = 'PENDING' and confirmed_at is null and failed_at is null)
    or (status = 'CONFIRMED' and confirmed_at is not null and failed_at is null)
    or (status = 'FAILED' and confirmed_at is null and failed_at is not null)
  )
);

create table gift_certificates.sale_commands (
  tenant_id uuid not null references identity.tenants(id),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (
    command_type in ('CREATE_ORDER', 'CREATE_PAYMENT', 'CONFIRM_SANDBOX_PAYMENT')
  ),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  order_id uuid not null,
  actor_user_id uuid,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  foreign key (tenant_id, order_id) references gift_certificates.orders(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id)
);

alter table gift_certificates.media_assets enable row level security;
alter table gift_certificates.media_commands enable row level security;
alter table gift_certificates.purchase_sessions enable row level security;
alter table gift_certificates.orders enable row level security;
alter table commerce.payment_operations enable row level security;
alter table gift_certificates.sale_commands enable row level security;

create policy gift_certificate_media_assets_tenant_isolation
  on gift_certificates.media_assets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_media_commands_tenant_isolation
  on gift_certificates.media_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_purchase_sessions_tenant_isolation
  on gift_certificates.purchase_sessions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_orders_tenant_isolation
  on gift_certificates.orders
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy commerce_payment_operations_tenant_isolation
  on commerce.payment_operations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_sale_commands_tenant_isolation
  on gift_certificates.sale_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gift_certificates.media_assets force row level security;
alter table gift_certificates.media_commands force row level security;
alter table gift_certificates.purchase_sessions force row level security;
alter table gift_certificates.orders force row level security;
alter table commerce.payment_operations force row level security;
alter table gift_certificates.sale_commands force row level security;
