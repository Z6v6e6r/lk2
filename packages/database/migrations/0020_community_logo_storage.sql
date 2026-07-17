-- Expand-only metadata for PadlHub-owned community logos copied from the temporary
-- LK legacy bridge. Legacy URLs remain integration-only; Home and User API receive
-- only a short-lived delivery URL for a private WebP object.

create table integration.community_logo_sync (
  tenant_id uuid not null references identity.tenants(id),
  community_id uuid not null,
  source_url text not null check (source_url ~ '^https://'),
  source_etag text,
  source_last_modified text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text not null check (
    object_key ~ '^community-logos/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  delivery_url text not null check (
    char_length(delivery_url) between 1 and 8192 and delivery_url ~ '^https?://'
  ),
  delivery_expires_at timestamptz not null,
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id),
  unique (tenant_id, object_key)
);

create index community_logo_sync_object_idx
  on integration.community_logo_sync (tenant_id, object_key);

create table integration.community_logo_object_gc (
  tenant_id uuid not null references identity.tenants(id),
  object_key text not null check (
    object_key ~ '^community-logos/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  delete_after timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, object_key)
);

create index community_logo_object_gc_due_idx
  on integration.community_logo_object_gc (tenant_id, delete_after);

alter table integration.community_logo_sync enable row level security;
alter table integration.community_logo_object_gc enable row level security;

create policy community_logo_sync_tenant_isolation
  on integration.community_logo_sync
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_logo_object_gc_tenant_isolation
  on integration.community_logo_object_gc
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.community_logo_sync force row level security;
alter table integration.community_logo_object_gc force row level security;
