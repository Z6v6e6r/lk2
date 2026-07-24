-- Expand-only lease metadata for staging validation of the short-transaction outbox publisher.
-- The default transactional publisher ignores these nullable columns.

alter table audit.outbox_events
  add column if not exists publish_claim_token uuid,
  add column if not exists publish_claim_expires_at timestamptz;

comment on column audit.outbox_events.publish_claim_token is
  'Opaque worker claim token; nullable for compatibility with the transactional publisher';
comment on column audit.outbox_events.publish_claim_expires_at is
  'Claim expiry used for crash recovery; an expired unpublished event may be claimed again';

create index if not exists outbox_unpublished_tenant_claim_idx
  on audit.outbox_events (tenant_id, occurred_at, id)
  where published_at is null;
