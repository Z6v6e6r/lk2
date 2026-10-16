import { vi } from 'vitest';
import {
  SUPPORT_TICKET_RUNTIME_PRIVILEGES,
  type SupportTicketAclSnapshot,
} from './support-ticket-acl.js';
import {
  SUPPORT_DATABASE_OWNER_ROLE,
  supportRuntimePrerequisiteDefinitions,
} from './support-ticket-prerequisites.js';
export function supportAclFixture(): SupportTicketAclSnapshot {
  return {
    runtime: {
      name: 'support_runtime',
      superuser: false,
      bypassRls: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      canAssumeOwner: false,
      schemaCreate: false,
    },
    schema: {
      owner: SUPPORT_DATABASE_OWNER_ROLE,
      grants: [
        { grantee: SUPPORT_DATABASE_OWNER_ROLE, privilege: 'CREATE', grantable: false },
        { grantee: 'support_runtime', privilege: 'USAGE', grantable: false },
      ],
    },
    relations: Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES).map(([name, privileges]) => ({
      name,
      owner: SUPPORT_DATABASE_OWNER_ROLE,
      forceRls: true,
      enabledRls: true,
      columnGrants: 0,
      runtimePrivileges: privileges,
      grants: privileges.map((privilege) => ({
        grantee: 'support_runtime',
        privilege,
        grantable: false,
      })),
      policies: [
        {
          name: `support_${name}_tenant`,
          command: '*',
          permissive: true,
          roles: ['PUBLIC'],
          using: "tenant_id=nullif(current_setting('app.tenant_id'::text,true),''::text)::uuid",
          check: "tenant_id=nullif(current_setting('app.tenant_id'::text,true),''::text)::uuid",
        },
      ],
    })),
    retentionGuards: [
      ['support_ticket_lifecycle_guard', 'tickets', 'support.guard_ticket_lifecycle', 23],
      ['support_message_retention_guard', 'messages', 'support.guard_retention_message_delete', 11],
      ['support_receipt_retention_guard', 'commands', 'support.guard_receipt_retirement', 19],
      ['support_archived_message_guard', 'messages', 'support.guard_archived_message_insert', 7],
    ].map(([name, relation, functionName, triggerType]) => ({
      name: String(name),
      relation: String(relation),
      functionName: String(functionName),
      triggerType: Number(triggerType),
      enabled: true,
      owner: SUPPORT_DATABASE_OWNER_ROLE,
      securityDefiner: false,
      argumentCount: 0,
      unconditional: true,
    })),
  };
}
export function supportPrivilegeFixture() {
  return {
    relations: [
      ...supportRuntimePrerequisiteDefinitions(),
      ...Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES).flatMap(([name, privileges]) =>
        privileges.map((privilege) => ({
          relation: `support.${name}`,
          privilege,
          columnName: null,
        })),
      ),
    ],
    schemas: ['support', 'identity', 'audit', 'notifications', 'public'].map((schemaName) => ({
      schemaName,
      privilege: 'USAGE',
    })),
    unsafe: false,
  };
}
export function supportCatalogClientFixture(
  overrides: {
    snapshot?: SupportTicketAclSnapshot;
    identity?: Record<string, unknown>;
    extra?: boolean;
    failAt?: string;
  } = {},
) {
  const snapshot = overrides.snapshot ?? supportAclFixture();
  const inventory = supportPrivilegeFixture();
  const query = vi.fn((sql: string) =>
    Promise.resolve().then(() => {
      if (overrides.failAt && sql.includes(overrides.failAt))
        throw new Error('synthetic private connection failure');
      if (sql.includes('support-owner-inventory'))
        return { rows: [{ unsafe: false, functionCount: 4, schemaCount: 1 }] };
      if (sql.includes('current_user as "roleName"') && sql.includes('pg_namespace'))
        return {
          rows: [
            {
              roleName: 'support_runtime',
              sessionRole: 'support_runtime',
              databaseName: 'phub',
              owner: SUPPORT_DATABASE_OWNER_ROLE,
              ownerUnsafe: false,
              ownerMemberships: 0,
              membershipCount: 0,
              recovery: false,
              ...overrides.identity,
            },
          ],
        };
      if (sql.includes('select has_database_privilege')) return { rows: [{ unsafe: false }] };
      if (sql.includes('pg_has_role(rolname')) return { rows: [snapshot.runtime] };
      if (sql.includes('n.nspowner') && sql.includes("n.nspname='support'"))
        return { rows: [snapshot.schema] };
      if (sql.includes('c.relforcerowsecurity')) return { rows: snapshot.relations };
      if (sql.includes('from pg_trigger')) return { rows: snapshot.retentionGuards };
      if (sql.includes('jsonb_to_recordset'))
        return {
          rows: supportRuntimePrerequisiteDefinitions().map((row) => ({
            ...row,
            allowed: true,
            schemaUsage: true,
          })),
        };
      if (sql.includes('with relations as'))
        return {
          rows: overrides.extra
            ? [
                ...inventory.relations,
                { relation: 'identity.users', privilege: 'UPDATE', columnName: null },
              ]
            : inventory.relations,
        };
      if (sql.includes('from pg_namespace n cross join')) return { rows: inventory.schemas };

      return { rows: [] };
    }),
  );
  return { query, release: vi.fn() };
}
