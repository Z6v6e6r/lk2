-- Expand-only source state and private responsive media for the temporary legacy CUP
-- advertising bridge. Legacy advertisement IDs and asset URLs stay in integration storage;
-- Home receives PadlHub UUIDs plus short-lived PadlHub object delivery URLs.

create table integration.promotion_home_source_components (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload -> 'items') = 'array'
    and jsonb_array_length(payload -> 'items') <= 20
  ),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  correlation_id text not null,
  fetched_at timestamptz not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index promotion_home_source_due_idx
  on integration.promotion_home_source_components (tenant_id, last_synced_at, user_id);

create table integration.promotion_media_sync (
  tenant_id uuid not null references identity.tenants(id),
  promotion_id uuid not null,
  source_url text not null check (source_url ~ '^https://'),
  source_etag text,
  source_last_modified text,
  desktop_sha256 text not null check (desktop_sha256 ~ '^[0-9a-f]{64}$'),
  mobile_sha256 text not null check (mobile_sha256 ~ '^[0-9a-f]{64}$'),
  desktop_object_key text not null check (
    desktop_object_key ~ '^promotion-media/[0-9a-f-]{36}/[0-9a-f-]{36}/desktop/[0-9a-f]{64}\.webp$'
  ),
  mobile_object_key text not null check (
    mobile_object_key ~ '^promotion-media/[0-9a-f-]{36}/[0-9a-f-]{36}/mobile/[0-9a-f]{64}\.webp$'
  ),
  desktop_delivery_url text not null check (
    char_length(desktop_delivery_url) between 1 and 8192 and desktop_delivery_url ~ '^https?://'
  ),
  mobile_delivery_url text not null check (
    char_length(mobile_delivery_url) between 1 and 8192 and mobile_delivery_url ~ '^https?://'
  ),
  delivery_expires_at timestamptz not null,
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, promotion_id),
  unique (tenant_id, desktop_object_key),
  unique (tenant_id, mobile_object_key)
);

create table integration.promotion_media_object_gc (
  tenant_id uuid not null references identity.tenants(id),
  object_key text not null check (
    object_key ~ '^promotion-media/[0-9a-f-]{36}/[0-9a-f-]{36}/(desktop|mobile)/[0-9a-f]{64}\.webp$'
  ),
  delete_after timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, object_key)
);

create index promotion_media_object_gc_due_idx
  on integration.promotion_media_object_gc (tenant_id, delete_after);

alter table integration.promotion_home_source_components enable row level security;
alter table integration.promotion_media_sync enable row level security;
alter table integration.promotion_media_object_gc enable row level security;

create policy promotion_home_source_components_tenant_isolation
  on integration.promotion_home_source_components
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy promotion_media_sync_tenant_isolation
  on integration.promotion_media_sync
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy promotion_media_object_gc_tenant_isolation
  on integration.promotion_media_object_gc
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.promotion_home_source_components force row level security;
alter table integration.promotion_media_sync force row level security;
alter table integration.promotion_media_object_gc force row level security;
