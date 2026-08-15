-- Harden Web Push endpoint ownership without rewriting existing endpoint history.
-- phub:reviewed-blocking-index
-- Web Push writers must be disabled and drained before this bounded migration. The index builds
-- intentionally run before the short ACCESS EXCLUSIVE constraint swap in the migrator transaction.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  current_tenant record;
begin
  for current_tenant in select id from identity.tenants order by id loop
    perform set_config('app.tenant_id', current_tenant.id::text, true);
    if exists (
      select 1
        from integration.notification_endpoints
       where tenant_id = current_tenant.id
         and channel = 'PUSH'
         and status in ('ACTIVE', 'SUSPENDED_POLICY')
       group by provider_account_id, address_hash
      having count(distinct user_id) > 1
    ) then
      raise exception
        'cannot enforce Web Push endpoint ownership: cross-user live address hashes exist for tenant %',
        current_tenant.id;
    end if;
  end loop;
end
$$;

create unique index notification_endpoints_live_address_owner_unique_idx
  on integration.notification_endpoints (tenant_id, provider_account_id, address_hash)
  where channel = 'PUSH' and status in ('ACTIVE', 'SUSPENDED_POLICY');

create index notification_endpoints_live_user_quota_idx
  on integration.notification_endpoints (tenant_id, user_id, provider_account_id)
  where channel = 'PUSH' and status in ('ACTIVE', 'SUSPENDED_POLICY');

-- Existing rows already satisfy the stricter v1 constraint. NOT VALID avoids a second table scan
-- while enforcing the expanded set for every new write; 0072 validates it in a separate lock scope.
alter table integration.notification_endpoints
  drop constraint notification_endpoints_status_check;

alter table integration.notification_endpoints
  add constraint notification_endpoints_status_check
  check (status in ('ACTIVE', 'INVALID', 'REVOKED', 'SUSPENDED_POLICY')) not valid;
