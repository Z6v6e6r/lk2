-- Expand-only indexes for transactional Community media issuance quotas.
-- Quota evidence remains in media_assets so idempotent replay and rolling
-- accounting use the same durable command state as the upload lifecycle.

create index if not exists community_media_actor_outstanding_quota_idx
  on community_content.media_assets (
    tenant_id, uploader_user_id, upload_expires_at, id
  )
  include (declared_size_bytes)
  where state = 'UPLOADING';

create index if not exists community_media_actor_daily_bytes_quota_idx
  on community_content.media_assets (
    tenant_id, uploader_user_id, created_at, id
  )
  include (declared_size_bytes);

create index if not exists community_media_actor_pipeline_quota_idx
  on community_content.media_assets (
    tenant_id, uploader_user_id, state, upload_expires_at, id
  )
  where state in ('UPLOADING', 'SCANNING');

create index if not exists community_media_tenant_pipeline_quota_idx
  on community_content.media_assets (
    tenant_id, state, upload_expires_at, id
  )
  include (declared_size_bytes)
  where state in ('UPLOADING', 'SCANNING');
