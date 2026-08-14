-- Backward-compatible operational recovery for Community media. Terminal
-- scan/GC evidence is kept beside the existing lifecycle state so old
-- application versions continue to understand every row during rolling
-- deployment. The only replacement below corrects an unusable 0067 CHECK.

-- 0067 originally escaped the WebP suffix for a JavaScript-style regular
-- expression. PostgreSQL standard-conforming strings retain both backslashes,
-- so canonical READY keys were rejected. Replace the constraint transactionally
-- for databases that already applied that migration before this repair.
alter table community_content.media_variants
  drop constraint if exists media_variants_object_key_check;
alter table community_content.media_variants
  add constraint media_variants_object_key_check
    check (
      object_key ~ '^community-media/ready/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(thumbnail|feed)/[0-9a-f]{64}\.webp$'
    ) not valid;
alter table community_content.media_variants
  validate constraint media_variants_object_key_check;

alter table community_content.media_assets
  add column if not exists scan_failed_at timestamptz,
  add column if not exists scan_failure_code text;

alter table community_content.media_assets
  add constraint community_media_scan_failure_code_check
    check (
      scan_failure_code is null
      or scan_failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
    ) not valid,
  add constraint community_media_scan_failure_pair_check
    check (
      (scan_failed_at is null and scan_failure_code is null)
      or (
        scan_failed_at is not null and scan_failure_code is not null
        and state = 'SCANNING'
        and scan_lease_owner is null and scan_lease_expires_at is null
      )
    ) not valid;

alter table community_content.media_assets
  validate constraint community_media_scan_failure_code_check;
alter table community_content.media_assets
  validate constraint community_media_scan_failure_pair_check;

alter table community_content.media_gc_jobs
  add column if not exists dead_at timestamptz,
  add column if not exists failure_code text;

alter table community_content.media_gc_jobs
  add constraint community_media_gc_failure_code_check
    check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$') not valid,
  add constraint community_media_gc_dead_pair_check
    check (
      (dead_at is null and failure_code is null)
      or (
        dead_at is not null and failure_code is not null
        and state = 'PENDING'
        and lease_owner is null and lease_expires_at is null
        and completed_at is null
      )
    ) not valid;

alter table community_content.media_gc_jobs
  validate constraint community_media_gc_failure_code_check;
alter table community_content.media_gc_jobs
  validate constraint community_media_gc_dead_pair_check;

create table if not exists community_content.media_operations_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  operation text not null check (operation in ('REPLAY_SCAN', 'REPLAY_GC')),
  target_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id)
);

create index if not exists community_media_failed_scan_idx
  on community_content.media_assets (tenant_id, scan_failed_at, id)
  where scan_failed_at is not null;
create index if not exists community_media_dead_gc_idx
  on community_content.media_gc_jobs (tenant_id, dead_at, id)
  where dead_at is not null;

alter table community_content.media_operations_commands enable row level security;
create policy community_media_operations_commands_tenant_isolation
  on community_content.media_operations_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table community_content.media_operations_commands force row level security;
