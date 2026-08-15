-- A direct Viva profile can authoritatively report photo=null. Persist that observation as an
-- idempotent command so the stable PadlHub mapping is removed and the old object becomes GC-only.

set local lock_timeout = '5s';

alter table integration.profile_photo_client_commands
  add column command_kind varchar(16) not null default 'UPSERT',
  alter column request_sha256 drop not null,
  alter column content_sha256 drop not null,
  alter column object_key drop not null,
  add constraint profile_photo_client_commands_kind_check
    check (command_kind in ('UPSERT', 'DELETE')) not valid,
  add constraint profile_photo_client_commands_payload_check check (
    (command_kind = 'UPSERT' and request_sha256 is not null and
      content_sha256 is not null and object_key is not null) or
    (command_kind = 'DELETE' and request_sha256 is null and
      content_sha256 is null and object_key is null and avatar_url is null)
  ) not valid;
