-- Client-assisted profile reads may relay bounded image bytes instead of a provider URL because
-- Viva blocks server-side profile reads. The normalized WebP remains server-owned and the source
-- URL is intentionally absent from the durable mapping for this path.

set local lock_timeout = '5s';

alter table integration.user_profile_photo_sync
  alter column source_url drop not null,
  add column client_grant_issued_at timestamptz;

create table integration.profile_photo_client_commands (
  tenant_id uuid not null,
  user_id uuid not null,
  idempotency_key varchar(128) not null,
  grant_id uuid not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text not null check (object_key ~ '^profile-photos/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'),
  grant_issued_at timestamptz not null,
  avatar_url text check (
    avatar_url is null or
    avatar_url ~ '^/public/api/v1/media/profile-photos/[0-9a-f-]{36}/[0-9a-f-]{36}$'
  ),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  primary key (tenant_id, user_id, idempotency_key),
  unique (tenant_id, user_id, grant_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index profile_photo_client_commands_expiry_idx
  on integration.profile_photo_client_commands (tenant_id, expires_at, user_id);

create index profile_photo_client_commands_pending_object_idx
  on integration.profile_photo_client_commands (tenant_id, object_key, expires_at)
  where avatar_url is null;

alter table integration.profile_photo_client_commands enable row level security;

create policy profile_photo_client_commands_tenant_isolation
  on integration.profile_photo_client_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.profile_photo_client_commands force row level security;

create table integration.profile_photo_observation_watermarks (
  tenant_id uuid not null,
  user_id uuid not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

alter table integration.profile_photo_observation_watermarks enable row level security;

create policy profile_photo_observation_watermarks_tenant_isolation
  on integration.profile_photo_observation_watermarks
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.profile_photo_observation_watermarks force row level security;
