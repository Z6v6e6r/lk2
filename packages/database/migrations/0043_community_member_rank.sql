-- Expand-only viewer ranking position for a canonical community membership.
-- The value is optional because a community may not publish a ranking yet.

alter table communities.memberships
  add column ranking_position integer
  check (ranking_position is null or ranking_position > 0);
