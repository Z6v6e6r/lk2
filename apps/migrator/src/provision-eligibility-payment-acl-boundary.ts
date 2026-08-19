import {
  ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS,
  assertEligibilityPaymentAclBoundary,
  type EligibilityPaymentAclRelation,
} from '@phub/database';
import { Client } from 'pg';

import { inspectEligibilityPaymentAclBoundary } from './eligibility-payment-acl-boundary.js';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function eligibilityPaymentAclProvisionStatements(input: {
  readonly phase: 'pre' | 'post';
  readonly runtimeRoleName: string;
  readonly expectedRelations?: readonly EligibilityPaymentAclRelation[];
}): readonly string[] {
  if (!input.runtimeRoleName) throw new Error('ELIGIBILITY_PAYMENT_ACL_RUNTIME_ROLE_INVALID');
  const runtimeRole = quoteIdentifier(input.runtimeRoleName);
  const statements = [
    'create schema if not exists eligibility authorization current_user',
    ...ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.flatMap((schema) => {
      const schemaName = quoteIdentifier(schema.schemaName);
      return [
        `revoke all privileges on schema ${schemaName} from public`,
        `revoke all privileges on schema ${schemaName} from ${runtimeRole}`,
        `grant usage on schema ${schemaName} to ${runtimeRole}`,
      ];
    }),
  ];
  if (input.phase === 'pre') return statements;

  const expectedRelations =
    input.expectedRelations ?? ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS;
  for (const relation of expectedRelations) {
    const qualified = `${quoteIdentifier(relation.schemaName)}.${quoteIdentifier(relation.relationName)}`;
    statements.push(`revoke all privileges on table ${qualified} from public`);
    statements.push(`revoke all privileges on table ${qualified} from ${runtimeRole}`);
    statements.push(
      `grant ${relation.runtimePrivileges.join(', ')} on table ${qualified} to ${runtimeRole}`,
    );
  }
  return statements;
}

export async function provisionEligibilityPaymentAclBoundary(input: {
  readonly migratorConnectionString: string;
  readonly runtimeRoleName: string;
  readonly phase: 'pre' | 'post';
  readonly expectedRelations?: readonly EligibilityPaymentAclRelation[];
}): Promise<void> {
  const expectedRelations =
    input.expectedRelations ?? ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS;
  const client = new Client({
    connectionString: input.migratorConnectionString,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local idle_in_transaction_session_timeout = '30s'");
    for (const statement of eligibilityPaymentAclProvisionStatements({
      phase: input.phase,
      runtimeRoleName: input.runtimeRoleName,
      expectedRelations,
    })) {
      await client.query(statement);
    }
    const snapshot = await inspectEligibilityPaymentAclBoundary(
      client,
      input.runtimeRoleName,
      input.phase,
      expectedRelations,
    );
    assertEligibilityPaymentAclBoundary({
      phase: input.phase,
      ...snapshot,
      expectedRelations,
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
