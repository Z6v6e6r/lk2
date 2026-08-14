-- Expand-only index for the canonical /communities/mine keyset order.
-- Membership activity owns this order. Community content edits must not fan out
-- ordering writes to every member of a large community.

create index if not exists community_memberships_mine_keyset_idx
  on communities.memberships (
    tenant_id,
    user_id,
    ((pinned_at is not null)) desc,
    updated_at desc,
    community_id
  )
  where status = 'ACTIVE';
