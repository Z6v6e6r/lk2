-- Expand-only metadata for server-owned profile photo synchronization.
-- Provider URLs remain in integration storage; client-facing profile state keeps
-- only a short-lived delivery URL for the PadlHub-owned WebP object.

create table if not exists integration.user_profile_photo_sync (
  tenant_id uuid not null,
  user_id uuid not null,
  source_url text not null check (source_url ~ '^https://'),
  source_etag text,
  source_last_modified text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text not null check (
    object_key ~ '^profile-photos/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, object_key)
);

create index if not exists user_profile_photo_sync_object_idx
  on integration.user_profile_photo_sync (tenant_id, object_key);

create table if not exists integration.profile_photo_object_gc (
  tenant_id uuid not null references identity.tenants(id),
  object_key text not null check (
    object_key ~ '^profile-photos/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  delete_after timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, object_key)
);

create index if not exists profile_photo_object_gc_due_idx
  on integration.profile_photo_object_gc (tenant_id, delete_after);

alter table integration.user_profile_photo_sync enable row level security;
alter table integration.profile_photo_object_gc enable row level security;

create policy user_profile_photo_sync_tenant_isolation
  on integration.user_profile_photo_sync
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy profile_photo_object_gc_tenant_isolation
  on integration.profile_photo_object_gc
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.user_profile_photo_sync force row level security;
alter table integration.profile_photo_object_gc force row level security;
