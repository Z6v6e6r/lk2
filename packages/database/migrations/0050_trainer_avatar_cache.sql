-- Expand-only Viva-primary trainer projection and PadlHub-owned avatar cache.
-- Provider identifiers and source URLs remain inside integration storage.

create table if not exists catalog.trainers (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table if not exists integration.trainer_avatar_sync (
  tenant_id uuid not null,
  trainer_id uuid not null,
  provider text not null check (provider in ('VIVA')),
  provider_trainer_id text not null check (char_length(provider_trainer_id) between 1 and 200),
  source_url text check (source_url is null or source_url ~ '^https://'),
  source_etag text,
  source_last_modified text,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text check (
    object_key is null or
    object_key ~ '^trainer-avatars/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'
  ),
  synced_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider, provider_trainer_id),
  foreign key (tenant_id, trainer_id) references catalog.trainers(tenant_id, id),
  unique (tenant_id, trainer_id),
  unique (tenant_id, object_key)
);

create index if not exists trainer_avatar_sync_object_idx
  on integration.trainer_avatar_sync (tenant_id, object_key)
  where object_key is not null;

alter table catalog.trainers enable row level security;
alter table integration.trainer_avatar_sync enable row level security;

create policy trainers_tenant_isolation on catalog.trainers
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy trainer_avatar_sync_tenant_isolation on integration.trainer_avatar_sync
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table catalog.trainers force row level security;
alter table integration.trainer_avatar_sync force row level security;
