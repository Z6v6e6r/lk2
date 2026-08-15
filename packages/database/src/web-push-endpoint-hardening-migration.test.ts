import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('web push endpoint hardening migration', () => {
  it('fails closed on ambiguous live ownership and adds quota-safe indexes', async () => {
    const [sql, validationSql] = await Promise.all([
      readFile(
        new URL('../migrations/0070_web_push_endpoint_hardening.sql', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../migrations/0072_web_push_endpoint_status_validation.sql', import.meta.url),
        'utf8',
      ),
    ]);

    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain('phub:reviewed-blocking-index');
    expect(sql).toContain('for current_tenant in select id from identity.tenants order by id loop');
    expect(sql).toContain("set_config('app.tenant_id', current_tenant.id::text, true)");
    expect(sql).toContain('where tenant_id = current_tenant.id');
    expect(sql).toContain('drop constraint notification_endpoints_status_check');
    expect(sql).toContain("'SUSPENDED_POLICY'");
    expect(sql).toContain('not valid');
    expect(sql).toContain('having count(distinct user_id) > 1');
    expect(sql).toContain("'cannot enforce Web Push endpoint ownership");
    expect(sql).toContain('notification_endpoints_live_address_owner_unique_idx');
    expect(sql).toContain('(tenant_id, provider_account_id, address_hash)');
    expect(sql).toContain('notification_endpoints_live_user_quota_idx');
    expect(sql).toContain('(tenant_id, user_id, provider_account_id)');
    expect(
      sql.match(/where channel = 'PUSH' and status in \('ACTIVE', 'SUSPENDED_POLICY'\)/g),
    ).toHaveLength(2);
    expect(sql).not.toContain('if not exists');
    expect(sql.indexOf('create unique index')).toBeLessThan(sql.indexOf('drop constraint'));
    expect(sql).not.toContain('update integration.notification_endpoints\n  set user_id');
    expect(validationSql).toContain("set local lock_timeout = '5s'");
    expect(validationSql).toContain('validate constraint notification_endpoints_status_check');
  });
});
