import {
  ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES,
} from '@phub/database';
import type { QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';

import { inspectEligibilityPaymentAclBoundary } from './eligibility-payment-acl-boundary.js';

const tenantExpression =
  "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function exactClient() {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  return {
    calls,
    query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      calls.push({ text, ...(values ? { values } : {}) });
      if (text.includes('runtime_exists')) {
        return Promise.resolve(
          result([
            {
              migrator_session_identity_exact: true,
              runtime_exists: true,
              runtime_distinct_from_migrator: true,
              runtime_superuser: false,
              runtime_bypass_rls: false,
              runtime_memberships: '0',
              migrator_superuser: false,
              migrator_bypass_rls: false,
              migrator_memberships: '0',
            },
          ]) as unknown as QueryResult<T>,
        );
      }
      if (text.includes('runtime_create')) {
        return Promise.resolve(
          result(
            ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.map((schema) => ({
              schema_name: schema.schemaName,
              exists: true,
              owned_by_migrator: schema.migratorOwnerRequired,
              runtime_usage: true,
              runtime_create: false,
              migrator_create: true,
              runtime_grant_options: '0',
              public_privileges: '0',
              unexpected_grantee_privileges: '0',
              non_owner_table_default_privileges: '0',
            })),
          ) as unknown as QueryResult<T>,
        );
      }
      if (text.includes('jsonb_to_recordset($1::jsonb)')) {
        return Promise.resolve(
          result(
            ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS.map((relation) => ({
              schema_name: relation.schemaName,
              relation_name: relation.relationName,
              exists: true,
              owned_by_migrator: true,
            })),
          ) as unknown as QueryResult<T>,
        );
      }
      return Promise.resolve(
        result(
          ELIGIBILITY_PAYMENT_ACL_RELATIONS.map((relation) => ({
            schema_name: relation.schemaName,
            relation_name: relation.relationName,
            exists: true,
            owned_by_migrator: true,
            force_rls: true,
            policy_inventory: [
              {
                name: relation.policyName,
                command: '*',
                roles: ['PUBLIC'],
                permissive: true,
                qual: tenantExpression,
                withCheck: tenantExpression,
              },
            ],
            runtime_privileges: [...relation.runtimePrivileges].sort(),
            runtime_grant_options: '0',
            public_privileges: '0',
            unexpected_grantee_privileges: '0',
            column_privileges: '0',
          })),
        ) as unknown as QueryResult<T>,
      );
    },
  };
}

describe('eligibility/payment ACL catalog inspector', () => {
  it('uses a parameterized exact schema inventory in the pre phase', async () => {
    const client = exactClient();
    const snapshot = await inspectEligibilityPaymentAclBoundary(client, 'phub_runtime', 'pre');

    expect(snapshot.schemas).toHaveLength(2);
    expect(snapshot.preexistingRelations).toHaveLength(4);
    expect(snapshot.relations).toBeUndefined();
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]?.text).toContain('roleid = runtime.oid');
    expect(client.calls[0]?.text).toContain('roleid = migrator.oid');
    expect(client.calls[1]?.values?.[0]).toBe('phub_runtime');
    expect(JSON.parse(String(client.calls[1]?.values?.[1]))).toEqual(['eligibility', 'games']);
    expect(client.calls[1]?.text).toContain('pg_catalog.pg_default_acl');
    expect(client.calls[2]?.text).toContain('owned_by_migrator');
  });

  it('reads exact relation ACL, policy and column-ACL evidence in the post phase', async () => {
    const client = exactClient();
    const snapshot = await inspectEligibilityPaymentAclBoundary(client, 'phub_runtime', 'post');

    expect(snapshot.relations).toHaveLength(10);
    expect(client.calls).toHaveLength(4);
    expect(client.calls[3]?.text).toContain('pg_catalog.has_table_privilege');
    expect(client.calls[3]?.text).toContain('pg_catalog.pg_policy');
    expect(client.calls[3]?.text).toContain('pg_catalog.pg_attribute');
    expect(JSON.parse(String(client.calls[3]?.values?.[1]))).toEqual(
      ELIGIBILITY_PAYMENT_ACL_RELATIONS.map((relation) => ({
        schema_name: relation.schemaName,
        relation_name: relation.relationName,
      })),
    );
  });
});
