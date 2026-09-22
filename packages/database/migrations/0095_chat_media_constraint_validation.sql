-- Validate the chat-media constraints that migration 0093 added as NOT VALID. Expansion and
-- validation are split so a slow scan of an existing table cannot roll the expand-only file back:
-- this file only validates, and validation takes SHARE UPDATE EXCLUSIVE instead of ACCESS
-- EXCLUSIVE, so readers and writers keep working while the check runs.
-- phub:reviewed-constraint-validation

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table messaging.message_attachments
  validate constraint message_attachments_ready_scan_check;

alter table messaging.messages
  validate constraint messages_hidden_pair_check;

alter table messaging.messages
  validate constraint messages_hidden_by_action_fkey;
