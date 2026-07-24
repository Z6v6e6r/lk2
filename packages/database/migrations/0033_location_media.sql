-- Storage-backed, tenant-isolated editorial media for public location galleries.
-- The gallery keeps only the stable PadlHub delivery URL; S3 object keys remain server-side.

create table locations.media_assets (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  status text not null default 'READY' check (status = 'READY'),
  object_key text not null check (
    object_key ~ '^location-media/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null check (content_type = 'image/webp'),
  byte_size integer not null check (byte_size between 1 and 8388608),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, object_key),
  unique (tenant_id, content_sha256),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id)
);

create table locations.media_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, asset_id) references locations.media_assets(tenant_id, id)
);

create index locations_media_assets_created_idx
  on locations.media_assets (tenant_id, created_at desc, id);

alter table locations.media_assets enable row level security;
alter table locations.media_commands enable row level security;

create policy location_media_assets_tenant_isolation on locations.media_assets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy location_media_commands_tenant_isolation on locations.media_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table locations.media_assets force row level security;
alter table locations.media_commands force row level security;
