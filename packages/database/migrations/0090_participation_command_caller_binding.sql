-- Expand-only: bind a participation command to the caller credential that created it.
--
-- Before this migration every caller for a tenant shared one `principal_key`, so the
-- acknowledgement lookup (tenant_id, principal_key, id) could not distinguish the caller that
-- authorized a command from any other holder of the same tenant-wide integration token. Any token
-- holder could therefore acknowledge another caller's command as APPLIED or FAILED.
--
-- `caller_key` carries a digest of the originating caller credential. It is nullable so that the
-- expand step is backward compatible and existing rows keep working; the route fails closed when a
-- caller credential is configured but does not match the one recorded on the command.

alter table eligibility.participation_commands
  add column if not exists caller_key text
    check (caller_key is null or caller_key ~ '^[0-9a-f]{64}$');

-- Acknowledgement lookups are by (tenant_id, caller_key, id); index the new predicate.
create index if not exists participation_commands_caller_idx
  on eligibility.participation_commands (tenant_id, caller_key, id)
  where caller_key is not null;
