-- Read-only. Set app.tenant_id in the approved read-only session before running.
select
  state,
  action,
  last_error_class,
  count(*) as operation_count,
  max(submit_attempts) as max_submit_attempts,
  max(readback_attempts) as max_readback_attempts,
  min(created_at) as oldest_created_at,
  min(next_attempt_at) filter (where state in ('READY', 'UNKNOWN')) as oldest_due_at,
  min(lease_expires_at) filter (where state in ('SUBMITTING', 'RECONCILING')) as oldest_lease_expiry
from integration.game_provider_operations
where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
group by state, action, last_error_class
order by state, action, last_error_class nulls first;

select provider, count(*) as operation_count,
       count(distinct provider_idempotency_key) as distinct_idempotency_key_count
from integration.game_provider_operations
where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
group by provider;
