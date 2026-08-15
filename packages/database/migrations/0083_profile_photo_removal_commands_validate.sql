-- Validate separately so the 0082 ACCESS EXCLUSIVE table alteration is committed before the scan.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table integration.profile_photo_client_commands
  validate constraint profile_photo_client_commands_kind_check;

alter table integration.profile_photo_client_commands
  validate constraint profile_photo_client_commands_payload_check;
