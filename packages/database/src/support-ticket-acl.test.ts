import { describe, expect, it } from 'vitest';
import {
  SUPPORT_TICKET_RUNTIME_PRIVILEGES,
  assertSupportTicketAclBoundary,
  supportTicketRuntimeGrantStatements,
  type SupportTicketAclSnapshot,
} from './support-ticket-acl.js';
const expected = { runtimeRoleName: 'runtime', migratorRoleName: 'owner' };
function valid(): SupportTicketAclSnapshot {
  return {
    retentionGuards: [
      {
        name: 'support_ticket_lifecycle_guard',
        relation: 'tickets',
        functionName: 'support.guard_ticket_lifecycle',
        triggerType: 23,
      },
      {
        name: 'support_message_retention_guard',
        relation: 'messages',
        functionName: 'support.guard_retention_message_delete',
        triggerType: 11,
      },
      {
        name: 'support_receipt_retention_guard',
        relation: 'commands',
        functionName: 'support.guard_receipt_retirement',
        triggerType: 19,
      },
      {
        name: 'support_archived_message_guard',
        relation: 'messages',
        functionName: 'support.guard_archived_message_insert',
        triggerType: 7,
      },
    ].map((definition) => ({
      ...definition,
      enabled: true,
      owner: 'owner',
      securityDefiner: false,
      argumentCount: 0,
      unconditional: true,
    })),
    runtime: {
      name: 'runtime',
      superuser: false,
      bypassRls: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      canAssumeOwner: false,
      schemaCreate: false,
    },
    schema: {
      owner: 'owner',
      grants: [
        { grantee: 'owner', privilege: 'CREATE', grantable: false },
        { grantee: 'runtime', privilege: 'USAGE', grantable: false },
      ],
    },
    relations: Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES).map(([name, privileges]) => ({
      name,
      owner: 'owner',
      forceRls: true,
      enabledRls: true,
      columnGrants: 0,
      runtimePrivileges: privileges,
      grants: privileges.map((privilege) => ({ grantee: 'runtime', privilege, grantable: false })),
      policies: [
        {
          name: `support_${name}_tenant`,
          command: '*',
          permissive: true,
          roles: ['PUBLIC'],
          using:
            "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
          check:
            "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
        },
      ],
    })),
  };
}
describe('support runtime ACL source boundary', () => {
  it('accepts only the explicit tenant-scoped least privilege inventory', () => {
    expect(() => assertSupportTicketAclBoundary(valid(), expected)).not.toThrow();
  });
  it('rejects elevated role, owner membership, schema CREATE, RLS or unexpected table grants', () => {
    for (const field of [
      'superuser',
      'bypassRls',
      'createRole',
      'createDatabase',
      'replication',
      'canAssumeOwner',
      'schemaCreate',
    ] as const)
      expect(() =>
        assertSupportTicketAclBoundary(
          { ...valid(), runtime: { ...valid().runtime, [field]: true } },
          expected,
        ),
      ).toThrow('SUPPORT_RUNTIME_ROLE_UNSAFE');
    for (const privilege of ['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
      const value = valid();
      expect(() =>
        assertSupportTicketAclBoundary(
          {
            ...value,
            relations: value.relations.map((row, index) =>
              index === 0
                ? { ...row, runtimePrivileges: [...row.runtimePrivileges, privilege] }
                : row,
            ),
          },
          expected,
        ),
      ).toThrow('SUPPORT_RELATION_GRANTS_INVALID');
    }
    for (const grantee of ['PUBLIC', 'unrelated']) {
      const value = valid();
      expect(() =>
        assertSupportTicketAclBoundary(
          {
            ...value,
            schema: {
              ...value.schema,
              grants: [...value.schema.grants, { grantee, privilege: 'USAGE', grantable: false }],
            },
          },
          expected,
        ),
      ).toThrow('SUPPORT_SCHEMA_GRANTS_INVALID');
    }
    const value = valid();
    expect(() =>
      assertSupportTicketAclBoundary(
        {
          ...value,
          relations: value.relations.map((row, index) =>
            index === 0 ? { ...row, forceRls: false } : row,
          ),
        },
        expected,
      ),
    ).toThrow('SUPPORT_RELATION_GRANTS_INVALID');
    expect(() =>
      assertSupportTicketAclBoundary(
        {
          ...value,
          relations: value.relations.map((row, index) =>
            index === 0
              ? { ...row, policies: row.policies.map((policy) => ({ ...policy, check: 'true' })) }
              : row,
          ),
        },
        expected,
      ),
    ).toThrow('SUPPORT_TENANT_POLICY_INVALID');
  });
  it('quotes exact role identifiers and generates only the bounded explicit inventory', () => {
    const statements = supportTicketRuntimeGrantStatements('runtime"quoted');
    expect(statements).toContain('grant usage on schema support to "runtime""quoted"');
    expect(statements).toContain(
      'grant SELECT, INSERT, UPDATE on table support."commands" to "runtime""quoted"',
    );
    expect(statements.join(' ')).not.toMatch(/grant all|default privileges|create role/iu);
  });
});

describe('support retention guard inventory', () => {
  it('rejects absent/disabled or privileged retention guards before accepting their DML grants', () => {
    expect(() =>
      assertSupportTicketAclBoundary({ ...valid(), retentionGuards: [] }, expected),
    ).toThrow('SUPPORT_RETENTION_GUARDS_INVALID');
    const fixture = valid();
    expect(() =>
      assertSupportTicketAclBoundary(
        {
          ...fixture,
          retentionGuards: fixture.retentionGuards.map((guard) => ({ ...guard, enabled: false })),
        },
        expected,
      ),
    ).toThrow('SUPPORT_RETENTION_GUARDS_INVALID');
    for (const invalid of [
      { relation: 'tickets' },
      { functionName: 'support.unrelated_guard' },
      { triggerType: 9 },
      { argumentCount: 1 },
      { unconditional: false },
    ]) {
      expect(() =>
        assertSupportTicketAclBoundary(
          {
            ...fixture,
            retentionGuards: fixture.retentionGuards.map((guard) =>
              guard.name === 'support_message_retention_guard' ? { ...guard, ...invalid } : guard,
            ),
          },
          expected,
        ),
      ).toThrow('SUPPORT_RETENTION_GUARDS_INVALID');
    }
  });
});
