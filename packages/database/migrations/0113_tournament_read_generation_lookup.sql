-- Expand only: exact original JOIN lookup for authenticated tournament read positions.
-- Nonunique deliberately: runtime LIMIT 2 refuses ambiguous historical originals.
-- Apply only through the approved migration runner; never on API startup.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- phub:reviewed-blocking-index -- existing table; bounded lock/statement timeouts. Real row-count/lock-duration review required before approved apply.
create index tournament_local_owner_generation_lookup
  on booking.tournament_local_attempts (tenant_id, tournament_id, owner_operation_id);
