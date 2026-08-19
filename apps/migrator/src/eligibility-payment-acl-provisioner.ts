import {
  ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  assertEligibilityPaymentAclBoundary,
  assertEligibilityPaymentAclMatrixBinding,
  assertEligibilityPaymentAclProvisioningBoundary,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';

import { inspectEligibilityPaymentAclBoundary } from './eligibility-payment-acl-boundary.js';

export const ELIGIBILITY_PAYMENT_ACL_PROVISION_CONFIRMATION =
  'PROVISION_ELIGIBILITY_PAYMENT_ACL_V1';

type ProvisionClient = {
  connect(): Promise<void>;
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

export type EligibilityPaymentAclProvisionClientFactory = (
  connectionString: string,
) => ProvisionClient;

export class EligibilityPaymentAclProvisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EligibilityPaymentAclProvisionError';
  }
}

function fail(code: string): never {
  throw new EligibilityPaymentAclProvisionError(code);
}

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0')) fail('ELIGIBILITY_PAYMENT_ACL_ROLE_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
}

function assertRestoreDatabase(value: string): void {
  if (!/^phub_restore_[0-9]+_[0-9]+$/.test(value)) {
    fail('ELIGIBILITY_PAYMENT_ACL_RESTORE_DATABASE_INVALID');
  }
}

function assertCloneConnectionString(connectionString: string, restoreDatabase: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail('ELIGIBILITY_PAYMENT_ACL_CONNECTION_BOUNDARY_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    parsed.port !== '5432' ||
    decodeURIComponent(parsed.pathname) !== `/${restoreDatabase}` ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail('ELIGIBILITY_PAYMENT_ACL_CONNECTION_BOUNDARY_INVALID');
  }
}

export async function provisionEligibilityPaymentAcl(
  input: {
    readonly connectionString: string;
    readonly runtimeRoleName: string;
    readonly restoreDatabase: string;
    readonly confirmation: string;
    readonly matrixVersion: string;
    readonly matrixSha256: string;
  },
  createClient: EligibilityPaymentAclProvisionClientFactory = (connectionString) =>
    new Client({
      connectionString,
      application_name: 'phub-eligibility-payment-acl-provisioner',
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }) as unknown as ProvisionClient,
): Promise<void> {
  assertRestoreDatabase(input.restoreDatabase);
  assertCloneConnectionString(input.connectionString, input.restoreDatabase);
  if (input.confirmation !== ELIGIBILITY_PAYMENT_ACL_PROVISION_CONFIRMATION) {
    fail('ELIGIBILITY_PAYMENT_ACL_CONFIRMATION_INVALID');
  }
  assertEligibilityPaymentAclMatrixBinding({
    version: input.matrixVersion,
    sha256: input.matrixSha256,
  });

  const client = createClient(input.connectionString);
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '30s'");
    const identity = await client.query<{ database_name: string; session_identity_exact: boolean }>(
      `select pg_catalog.current_database() as database_name,
              session_user = current_user as session_identity_exact`,
    );
    if (
      identity.rows[0]?.database_name !== input.restoreDatabase ||
      !identity.rows[0]?.session_identity_exact
    ) {
      fail('ELIGIBILITY_PAYMENT_ACL_DATABASE_BOUNDARY_INVALID');
    }
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtext('eligibility-payment-acl-v1'),
         pg_catalog.hashtext($1)
       )`,
      [input.restoreDatabase],
    );

    const before = await inspectEligibilityPaymentAclBoundary(
      client,
      input.runtimeRoleName,
      'post',
    );
    assertEligibilityPaymentAclProvisioningBoundary({
      ...before,
      relations: before.relations ?? [],
    });

    const runtimeRole = quoteIdentifier(input.runtimeRoleName);
    for (const relation of ELIGIBILITY_PAYMENT_ACL_RELATIONS) {
      const privileges = relation.runtimePrivileges.join(', ');
      await client.query(
        `grant ${privileges} on table ${quoteIdentifier(relation.schemaName)}.${quoteIdentifier(relation.relationName)} to ${runtimeRole}`,
      );
    }

    const after = await inspectEligibilityPaymentAclBoundary(client, input.runtimeRoleName, 'post');
    assertEligibilityPaymentAclBoundary({ phase: 'post', ...after });
    await client.query('commit');
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export const eligibilityPaymentAclProvisionDefaults = {
  matrixVersion: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  matrixSha256: ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
} as const;
