-- Expand-only Communities image lifecycle. PostgreSQL owns state and attachment
-- relations. Object storage contains private, versioned quarantine objects and
-- normalized WebP variants. Provider object versions are immutable capabilities:
-- a worker must always read the exact version captured by finalize.

create table if not exists community_content.media_assets (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  community_id uuid not null,
  uploader_user_id uuid not null,
  media_type text not null default 'IMAGE' check (media_type = 'IMAGE'),
  state text not null default 'UPLOADING'
    check (state in ('UPLOADING', 'SCANNING', 'READY', 'REJECTED', 'EXPIRED', 'PURGED')),
  source_object_key text not null check (
    source_object_key ~ '^community-media/quarantine/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/source$'
  ),
  source_object_version text check (
    source_object_version is null or char_length(source_object_version) between 1 and 1024
  ),
  declared_content_type text not null
    check (declared_content_type in ('image/jpeg', 'image/png', 'image/webp')),
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 15728640),
  declared_sha256 text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  source_content_type text check (
    source_content_type is null or source_content_type in ('image/jpeg', 'image/png', 'image/webp')
  ),
  source_size_bytes bigint check (source_size_bytes between 1 and 15728640),
  source_etag text check (source_etag is null or char_length(source_etag) between 1 and 1024),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  bound_post_id uuid,
  revision bigint not null default 1 check (revision > 0),
  scan_lease_owner text check (
    scan_lease_owner is null or char_length(scan_lease_owner) between 1 and 128
  ),
  scan_lease_expires_at timestamptz,
  scan_available_at timestamptz not null default now(),
  scan_attempts integer not null default 0 check (scan_attempts >= 0),
  last_scan_error_code text check (
    last_scan_error_code is null or last_scan_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  upload_expires_at timestamptz not null,
  finalized_at timestamptz,
  ready_at timestamptz,
  rejected_at timestamptz,
  rejection_code text check (
    rejection_code is null or rejection_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  unattached_expires_at timestamptz,
  expired_at timestamptz,
  retention_until timestamptz,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, community_id, id),
  unique (tenant_id, source_object_key),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, uploader_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id, bound_post_id)
    references community_content.posts(tenant_id, community_id, id),
  check (upload_expires_at > created_at),
  check (source_size_bytes is null or source_size_bytes = declared_size_bytes),
  check (source_content_type is null or source_content_type = declared_content_type),
  check (source_sha256 is null or source_sha256 = declared_sha256),
  check (
    (scan_lease_owner is null and scan_lease_expires_at is null)
    or (
      state = 'SCANNING'
      and scan_lease_owner is not null
      and scan_lease_expires_at is not null
    )
  ),
  check (
    (state = 'UPLOADING'
      and source_object_version is null
      and finalized_at is null and ready_at is null and rejected_at is null
      and expired_at is null and purged_at is null)
    or
    (state = 'SCANNING'
      and source_object_version is not null and source_etag is not null
      and source_content_type is not null and source_size_bytes is not null
      and source_sha256 is not null
      and finalized_at is not null and ready_at is null and rejected_at is null
      and expired_at is null and purged_at is null)
    or
    (state = 'READY'
      and source_object_version is not null and source_etag is not null
      and source_content_type is not null and source_size_bytes is not null
      and source_sha256 is not null and finalized_at is not null and ready_at is not null
      and rejected_at is null and expired_at is null and purged_at is null)
    or
    (state = 'REJECTED'
      and source_object_version is not null and source_etag is not null
      and source_content_type is not null and source_size_bytes is not null
      and source_sha256 is not null and finalized_at is not null
      and rejected_at is not null and rejection_code is not null
      and ready_at is null and expired_at is null and purged_at is null)
    or
    (state = 'EXPIRED'
      and expired_at is not null and purged_at is null)
    or
    (state = 'PURGED'
      and purged_at is not null)
  ),
  check (bound_post_id is null or state in ('READY', 'EXPIRED', 'PURGED')),
  check (unattached_expires_at is null or (state = 'READY' and bound_post_id is null)),
  check (retention_until is null or bound_post_id is not null)
);

create table if not exists community_content.media_variants (
  tenant_id uuid not null,
  media_id uuid not null,
  id uuid not null default gen_random_uuid(),
  variant_name text not null check (variant_name in ('THUMBNAIL', 'FEED')),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'PURGED')),
  object_key text not null check (
    object_key ~ '^community-media/ready/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(thumbnail|feed)/[0-9a-f]{64}\\.webp$'
  ),
  object_version text not null check (char_length(object_version) between 1 and 1024),
  object_etag text not null check (char_length(object_etag) between 1 and 1024),
  content_type text not null default 'image/webp' check (content_type = 'image/webp'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  created_at timestamptz not null default now(),
  purged_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, media_id, id),
  unique (tenant_id, media_id, variant_name),
  unique (tenant_id, object_key, object_version),
  foreign key (tenant_id, media_id)
    references community_content.media_assets(tenant_id, id),
  check (
    (state = 'ACTIVE' and purged_at is null)
    or (state = 'PURGED' and purged_at is not null)
  )
);

-- Attachments are snapshots of an immutable post revision. A media asset may
-- appear in later revisions of the same post, but `bound_post_id` prevents it
-- from being reused by another post.
create table if not exists community_content.post_revision_media (
  tenant_id uuid not null,
  community_id uuid not null,
  post_id uuid not null,
  post_revision bigint not null check (post_revision > 0),
  media_id uuid not null,
  position smallint not null check (position between 1 and 10),
  attached_at timestamptz not null default now(),
  primary key (tenant_id, post_id, post_revision, position),
  unique (tenant_id, post_id, post_revision, media_id),
  foreign key (tenant_id, community_id, post_id)
    references community_content.posts(tenant_id, community_id, id),
  foreign key (tenant_id, post_id, post_revision)
    references community_content.post_revisions(tenant_id, post_id, revision),
  foreign key (tenant_id, community_id, media_id)
    references community_content.media_assets(tenant_id, community_id, id)
);

create table if not exists community_content.media_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  command_type text not null check (command_type in ('ISSUE_UPLOAD', 'FINALIZE_UPLOAD')),
  media_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id, media_id)
    references community_content.media_assets(tenant_id, community_id, id)
);

create table if not exists community_content.media_gc_jobs (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  media_id uuid not null,
  variant_id uuid,
  object_kind text not null check (object_kind in ('SOURCE', 'VARIANT')),
  object_key text not null check (char_length(object_key) between 1 and 1024),
  object_version text not null check (char_length(object_version) between 1 and 1024),
  state text not null default 'PENDING' check (state in ('PENDING', 'LEASED', 'DONE')),
  available_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or char_length(lease_owner) between 1 and 128),
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, object_key, object_version),
  foreign key (tenant_id, media_id)
    references community_content.media_assets(tenant_id, id),
  foreign key (tenant_id, media_id, variant_id)
    references community_content.media_variants(tenant_id, media_id, id),
  check (
    (object_kind = 'SOURCE' and variant_id is null)
    or (object_kind = 'VARIANT' and variant_id is not null)
  ),
  check (
    (state = 'PENDING' and lease_owner is null and lease_expires_at is null and completed_at is null)
    or
    (state = 'LEASED' and lease_owner is not null and lease_expires_at is not null
      and completed_at is null)
    or
    (state = 'DONE' and lease_owner is null and lease_expires_at is null
      and completed_at is not null)
  )
);

-- Cross-row lifecycle invariants cannot be expressed by a plain CHECK. Keep
-- them deferred so a single command transaction can insert variants, bind the
-- media and then create the immutable revision snapshot in either safe order.
create or replace function community_content.enforce_ready_media_variants()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'READY' and not exists (
    select 1
      from community_content.media_variants variant
     where variant.tenant_id = new.tenant_id
       and variant.media_id = new.id
       and variant.state = 'ACTIVE'
  ) then
    raise exception 'COMMUNITY_MEDIA_READY_VARIANT_REQUIRED';
  end if;
  return new;
end;
$$;

create constraint trigger community_media_ready_variants_guard
after insert or update of state on community_content.media_assets
deferrable initially deferred
for each row execute function community_content.enforce_ready_media_variants();

create or replace function community_content.enforce_ready_revision_attachment()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
      from community_content.media_assets media
     where media.tenant_id = new.tenant_id
       and media.community_id = new.community_id
       and media.id = new.media_id
       and media.state = 'READY'
       and media.bound_post_id = new.post_id
  ) then
    raise exception 'COMMUNITY_POST_REVISION_MEDIA_NOT_READY';
  end if;
  return new;
end;
$$;

create constraint trigger community_post_revision_media_ready_guard
after insert or update on community_content.post_revision_media
deferrable initially deferred
for each row execute function community_content.enforce_ready_revision_attachment();

create index if not exists community_media_scan_claim_idx
  on community_content.media_assets (tenant_id, scan_available_at, finalized_at, id)
  where state = 'SCANNING';
create index if not exists community_media_expiry_idx
  on community_content.media_assets (tenant_id, upload_expires_at, unattached_expires_at,
                                      retention_until, id)
  where state in ('UPLOADING', 'READY');
create index if not exists community_post_revision_media_lookup_idx
  on community_content.post_revision_media
    (tenant_id, community_id, post_id, post_revision, position);
create index if not exists community_media_gc_claim_idx
  on community_content.media_gc_jobs (tenant_id, available_at, id)
  where state <> 'DONE';

alter table community_content.media_assets enable row level security;
alter table community_content.media_variants enable row level security;
alter table community_content.post_revision_media enable row level security;
alter table community_content.media_commands enable row level security;
alter table community_content.media_gc_jobs enable row level security;

create policy community_media_assets_tenant_isolation on community_content.media_assets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_media_variants_tenant_isolation on community_content.media_variants
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_post_revision_media_tenant_isolation
  on community_content.post_revision_media
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_media_commands_tenant_isolation on community_content.media_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_media_gc_jobs_tenant_isolation on community_content.media_gc_jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table community_content.media_assets force row level security;
alter table community_content.media_variants force row level security;
alter table community_content.post_revision_media force row level security;
alter table community_content.media_commands force row level security;
alter table community_content.media_gc_jobs force row level security;
