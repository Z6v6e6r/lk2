import {
  ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES,
} from '@phub/database';
import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  ELIGIBILITY_PAYMENT_ACL_PROVISION_CONFIRMATION,
  EligibilityPaymentAclProvisionError,
  provisionEligibilityPaymentAcl,
  type EligibilityPaymentAclProvisionClientFactory,
} from './eligibility-payment-acl-provisioner.js';

const tenantExpression =
  "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function createClient(input: {
  readonly partialPrivileges?: boolean;
  readonly wrongDatabase?: boolean;
}) {
  const queries: string[] = [];
  const connect = vi.fn(() => Promise.resolve());
  let grantsApplied = false;
  const query = vi.fn(<T extends Record<string, unknown>>(text: string) => {
    queries.push(text);
    if (text.startsWith('grant ')) {
      grantsApplied = true;
      return Promise.resolve(result([]) as QueryResult<T>);
    }
    if (text.includes('current_database() as database_name')) {
      return Promise.resolve(
        result([
          {
            database_name: input.wrongDatabase ? 'padlhub' : 'phub_restore_123_1',
            session_identity_exact: true,
          },
        ]) as unknown as QueryResult<T>,
      );
    }
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
            owned_by_migrator: true,
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
    if (text.includes('policy_inventory')) {
      return Promise.resolve(
        result(
          ELIGIBILITY_PAYMENT_ACL_RELATIONS.map((relation, index) => ({
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
            runtime_privileges: grantsApplied
              ? [...relation.runtimePrivileges].sort()
              : input.partialPrivileges && index === 0
                ? ['SELECT', 'UPDATE']
                : [],
            runtime_grant_options: '0',
            public_privileges: '0',
            unexpected_grantee_privileges: '0',
            column_privileges: '0',
          })),
        ) as unknown as QueryResult<T>,
      );
    }
    return Promise.resolve(result([]) as QueryResult<T>);
  });
  return {
    client: {
      connect,
      query,
      end: vi.fn(() => Promise.resolve()),
    } as unknown as ReturnType<EligibilityPaymentAclProvisionClientFactory>,
    queries,
    connect,
  };
}

const exactInput = {
  connectionString: 'postgresql://migrator@postgres:5432/phub_restore_123_1',
  runtimeRoleName: 'phub_runtime',
  restoreDatabase: 'phub_restore_123_1',
  confirmation: ELIGIBILITY_PAYMENT_ACL_PROVISION_CONFIRMATION,
  matrixVersion: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  matrixSha256: ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
};

describe('eligibility/payment ACL provisioner', () => {
  it('grants only the exact matrix inside a clone-bound transaction and postchecks before commit', async () => {
    const { client, queries } = createClient({});
    await expect(provisionEligibilityPaymentAcl(exactInput, () => client)).resolves.toBeUndefined();
    const grants = queries.filter((query) => query.startsWith('grant '));
    expect(grants).toHaveLength(ELIGIBILITY_PAYMENT_ACL_RELATIONS.length);
    expect(grants.join('\n')).not.toMatch(/grant all|alter default privileges|create on schema/i);
    expect(queries.indexOf('commit')).toBeGreaterThan(queries.lastIndexOf(grants.at(-1) ?? ''));
    expect(queries.at(-1)).toBe('commit');
  });

  it('fails before grants for a shared database or partially drifted ACL state', async () => {
    const wrong = createClient({ wrongDatabase: true });
    await expect(provisionEligibilityPaymentAcl(exactInput, () => wrong.client)).rejects.toEqual(
      new EligibilityPaymentAclProvisionError('ELIGIBILITY_PAYMENT_ACL_DATABASE_BOUNDARY_INVALID'),
    );
    expect(wrong.queries).not.toEqual(expect.arrayContaining([expect.stringMatching(/^grant /)]));
    expect(wrong.queries.at(-1)).toBe('rollback');

    const partial = createClient({ partialPrivileges: true });
    await expect(provisionEligibilityPaymentAcl(exactInput, () => partial.client)).rejects.toThrow(
      'ELIGIBILITY_PAYMENT_ACL_PROVISIONING_STATE_INVALID',
    );
    expect(partial.queries.some((query) => query.startsWith('grant '))).toBe(false);
    expect(partial.queries.at(-1)).toBe('rollback');
  });

  it('rejects a malformed clone name and wrong confirmation before connecting', async () => {
    const { client, connect } = createClient({});
    await expect(
      provisionEligibilityPaymentAcl({ ...exactInput, restoreDatabase: 'padlhub' }, () => client),
    ).rejects.toThrow('ELIGIBILITY_PAYMENT_ACL_RESTORE_DATABASE_INVALID');
    await expect(
      provisionEligibilityPaymentAcl({ ...exactInput, confirmation: 'YES' }, () => client),
    ).rejects.toThrow('ELIGIBILITY_PAYMENT_ACL_CONFIRMATION_INVALID');
    await expect(
      provisionEligibilityPaymentAcl(
        {
          ...exactInput,
          connectionString: 'postgresql://migrator@staging:5432/phub_restore_123_1',
        },
        () => client,
      ),
    ).rejects.toThrow('ELIGIBILITY_PAYMENT_ACL_CONNECTION_BOUNDARY_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });
});
