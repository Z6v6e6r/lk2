-- Durable recovery hints are retained for 30 days. The head keeps the exact lower bound so an
-- expired cursor fails closed and clients reload canonical feed/comment state.

alter table community_content.event_heads
  add column if not exists retained_from_sequence bigint not null default 1
    check (retained_from_sequence > 0),
  add column if not exists retention_due_at timestamptz,
  add column if not exists purge_claim_token uuid,
  add column if not exists purge_claim_expires_at timestamptz,
  add constraint community_event_head_retained_bound_check
    check (retained_from_sequence <= last_sequence + 1) not valid,
  add constraint community_event_head_purge_claim_pair_check
    check ((purge_claim_token is null) = (purge_claim_expires_at is null)) not valid;

-- Both tables are FORCE RLS. Backfill one tenant at a time instead of relying on a migration role
-- that may or may not have BYPASSRLS.
do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    update community_content.event_heads head
       set retained_from_sequence = coalesce(
             (select min(event.sequence)
                from community_content.events event
               where event.tenant_id = head.tenant_id
                 and event.community_id = head.community_id),
             head.last_sequence + 1
           ),
           retention_due_at = (
             select min(event.occurred_at) + interval '30 days'
               from community_content.events event
              where event.tenant_id = head.tenant_id
                and event.community_id = head.community_id
           )
     where head.tenant_id = current_tenant_id;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

alter table community_content.event_heads
  validate constraint community_event_head_retained_bound_check,
  validate constraint community_event_head_purge_claim_pair_check;

create index if not exists community_event_heads_retention_due_idx
  on community_content.event_heads (tenant_id, retention_due_at, community_id)
  where retention_due_at is not null;

-- Rollback compatibility: an older API image does not know retention_due_at and can append the
-- first event after a fully purged stream. The worker has a bounded repair path for such heads.
create index if not exists community_event_heads_retention_due_repair_idx
  on community_content.event_heads (tenant_id, community_id)
  where retention_due_at is null and retained_from_sequence <= last_sequence;
