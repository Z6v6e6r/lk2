import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('eligibility tenant defaults migration', () => {
  it('provisions a canonical scale, explicit OFF policies and false readiness for future tenants', async () => {
    const sql = await readFile(
      new URL('../migrations/0089_eligibility_tenant_defaults.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('after insert on identity.tenants');
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("'OFF', 1, 'Safe initial policy'");
    expect(sql).toContain("('GAME'), ('TOURNAMENT'), ('TRAINING')");
    expect(sql).toContain('insert into eligibility.activation_readiness');
    expect(sql).toContain("set_config('app.tenant_id', new.id::text, true)");
    expect(sql).toContain("tg_relid <> 'identity.tenants'::regclass");
    expect(sql).toContain(
      'revoke all on function eligibility.provision_tenant_defaults() from public',
    );
    expect(sql).toContain("pg_catalog.acldefault('f', procedure.proowner)");
    expect(sql).toContain('privilege.grantee <> procedure.proowner');
    expect(sql).toContain('procedure.proconfig = array[\'search_path=""\']::text[]');
    expect(sql).toContain('ELIGIBILITY_TENANT_DEFAULTS_FUNCTION_ACL_INVALID');
    expect(sql).toContain('ELIGIBILITY_TENANT_DEFAULTS_TRIGGER_SHAPE_INVALID');
    expect(sql).toContain('related_trigger_count <> 1');
    expect(sql).toContain('trigger.tgtype = 5');
    expect(sql).toContain("trigger.tgenabled = 'O'");
    expect(sql).toContain('trigger.tgnargs = 0');
    expect(sql).toContain('canonical_mismatch_count');
    expect(sql).toContain('ELIGIBILITY_TENANT_DEFAULTS_PARTIAL');
    expect(sql).toContain('ELIGIBILITY_TENANT_DEFAULTS_POSTCONDITION_FAILED');
    expect(sql).not.toContain('on conflict do nothing');
    expect(sql).not.toContain('drop trigger');
    expect(sql).not.toMatch(/\b(delete|truncate)\b/iu);
  });
});
