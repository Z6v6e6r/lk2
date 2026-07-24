-- Expand-only opaque identifier for stable profile-photo delivery. Existing runtimes ignore the
-- new column and may continue writing signed URLs until every node has been promoted. New API reads
-- resolve the delivery id from the object mapping and never expose the user id in public cards.

alter table integration.user_profile_photo_sync
  add column if not exists delivery_id uuid;

update integration.user_profile_photo_sync
   set delivery_id = gen_random_uuid()
 where delivery_id is null;

alter table integration.user_profile_photo_sync
  alter column delivery_id set default gen_random_uuid(),
  alter column delivery_id set not null;

create unique index if not exists user_profile_photo_sync_delivery_idx
  on integration.user_profile_photo_sync (tenant_id, delivery_id);
