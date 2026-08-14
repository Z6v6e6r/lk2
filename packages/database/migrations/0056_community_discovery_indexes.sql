-- Expand-only indexes for authenticated canonical community discovery/detail.
-- HIDDEN rows remain absent from discovery. PUBLIC descriptions may participate
-- in search; LISTED_PRIVATE descriptions deliberately never do.

create extension if not exists pg_trgm;

create index if not exists community_discovery_created_idx
  on communities.communities (tenant_id, created_at desc, id desc)
  where status = 'ACTIVE' and visibility in ('PUBLIC', 'LISTED_PRIVATE');

create index if not exists community_discovery_title_trgm_idx
  on communities.communities using gin (lower(title) gin_trgm_ops)
  where status = 'ACTIVE' and visibility in ('PUBLIC', 'LISTED_PRIVATE');

create index if not exists community_public_description_trgm_idx
  on communities.communities using gin (lower(coalesce(description, '')) gin_trgm_ops)
  where status = 'ACTIVE' and visibility = 'PUBLIC';

create index if not exists community_active_members_count_idx
  on communities.memberships (tenant_id, community_id)
  where status = 'ACTIVE';
