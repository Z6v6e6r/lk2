import { describe, it, expect } from 'vitest';
import {
  assertSupportRuntimePrerequisites,
  supportRuntimePrerequisiteDefinitions,
  assertSupportRuntimePrivilegeInventory,
  supportRuntimePrerequisiteGrantStatements,
} from './support-ticket-prerequisites.js';
import { supportPrivilegeFixture, supportAclFixture } from './support-ticket-activation.fixture.js';
import { assertSupportTicketAclProvisioningBoundary } from './support-ticket-activation.js';
describe('support least privilege boundaries', () => {
  const valid = () =>
    supportRuntimePrerequisiteDefinitions().map((row) => ({
      ...row,
      allowed: true,
      schemaUsage: true,
    }));
  it('requires each column grant and rejects duplicate, missing or denied rows', () => {
    expect(() => assertSupportRuntimePrerequisites(valid())).not.toThrow();
    const rows = valid();
    for (const invalid of [
      rows.slice(1),
      [...rows, rows[0]!],
      rows.map((row, i) => (i === 0 ? { ...row, allowed: false } : row)),
      rows.map((row, i) => (i === 0 ? { ...row, schemaUsage: false } : row)),
    ])
      expect(() => assertSupportRuntimePrerequisites(invalid)).toThrow();
  });
  it('accepts only an incomplete subset before DCL and the exact effective inventory afterwards', () => {
    expect(() => assertSupportRuntimePrivilegeInventory(supportPrivilegeFixture())).not.toThrow();
    expect(() =>
      assertSupportRuntimePrivilegeInventory({ relations: [], schemas: [], unsafe: false }, 'pre'),
    ).not.toThrow();
    expect(() =>
      assertSupportRuntimePrivilegeInventory({ relations: [], schemas: [], unsafe: false }),
    ).toThrow();
    const f = supportPrivilegeFixture();
    for (const changed of [
      { ...f, unsafe: true },
      {
        ...f,
        relations: [
          ...f.relations,
          {
            relation: 'identity.user_access_profiles',
            privilege: 'UPDATE',
            columnName: 'permissions',
          },
        ],
      },
      {
        ...f,
        relations: [
          ...f.relations,
          { relation: 'identity.users', privilege: 'UPDATE', columnName: null },
        ],
      },
      { ...f, schemas: [...f.schemas, { schemaName: 'identity', privilege: 'CREATE' }] },
    ])
      expect(() => assertSupportRuntimePrivilegeInventory(changed, 'pre')).toThrow();
  });
  it('generates exact column-only dependency DCL, no role/identity/operator mutations', () => {
    const sql = supportRuntimePrerequisiteGrantStatements('support_runtime').join('\n');
    expect(sql).toContain('grant UPDATE ("updated_at") on table identity.users');
    expect(sql).not.toMatch(
      /grant UPDATE on|default privileges|create role|insert into|grant all/iu,
    );
    expect(() => supportRuntimePrerequisiteGrantStatements('injected"')).toThrow();
  });
  it('refuses to repair an unexpected support preimage grant', () => {
    const f = supportAclFixture();
    expect(() =>
      assertSupportTicketAclProvisioningBoundary(f, {
        runtimeRoleName: 'support_runtime',
        migratorRoleName: f.schema.owner,
      }),
    ).not.toThrow();
    expect(() =>
      assertSupportTicketAclProvisioningBoundary(
        {
          ...f,
          schema: {
            ...f.schema,
            grants: [
              ...f.schema.grants,
              { grantee: 'PUBLIC', privilege: 'USAGE', grantable: false },
            ],
          },
        },
        { runtimeRoleName: 'support_runtime', migratorRoleName: f.schema.owner },
      ),
    ).toThrow('SUPPORT_ACL_PREIMAGE_DRIFT');
  });
});
