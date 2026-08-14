-- Validate separately so the expand migration does not scan the table while holding its DDL lock.

set local lock_timeout = '5s';

alter table integration.community_logo_sync
  validate constraint community_logo_sync_delivery_pair_chk;
