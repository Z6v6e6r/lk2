-- Validate the expanded endpoint status constraint outside migration 0070's index-build lock scope.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table integration.notification_endpoints
  validate constraint notification_endpoints_status_check;
