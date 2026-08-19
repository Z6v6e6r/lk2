import { randomUUID } from 'node:crypto';

import {
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  assertEligibilityPaymentAclMatrixBinding,
} from '@phub/database';
import { Client } from 'pg';

export const ELIGIBILITY_PAYMENT_RUNTIME_PROBE_CONFIRMATION =
  'VERIFY_ELIGIBILITY_PAYMENT_RUNTIME_RLS_V1';

export type EligibilityPaymentRuntimeProbeClient = {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

export type EligibilityPaymentRuntimeProbeClientFactory = (
  connectionString: string,
) => EligibilityPaymentRuntimeProbeClient;

export class EligibilityPaymentRuntimeProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EligibilityPaymentRuntimeProbeError';
  }
}

function fail(code: string): never {
  throw new EligibilityPaymentRuntimeProbeError(code);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function assertRestoreDatabase(value: string): void {
  if (!/^phub_restore_[0-9]+_[0-9]+$/.test(value)) {
    fail('ELIGIBILITY_PAYMENT_RUNTIME_RESTORE_DATABASE_INVALID');
  }
}

function assertCloneConnectionString(connectionString: string, restoreDatabase: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail('ELIGIBILITY_PAYMENT_RUNTIME_CONNECTION_BOUNDARY_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    parsed.port !== '5432' ||
    decodeURIComponent(parsed.pathname) !== `/${restoreDatabase}` ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail('ELIGIBILITY_PAYMENT_RUNTIME_CONNECTION_BOUNDARY_INVALID');
  }
}

async function expectInsufficientPrivilege(
  client: EligibilityPaymentRuntimeProbeClient,
  savepoint: string,
  statement: string,
  values?: readonly unknown[],
): Promise<void> {
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    if (postgresErrorCode(error) === '42501') return;
    throw error;
  }
  fail('ELIGIBILITY_PAYMENT_RUNTIME_FORBIDDEN_OPERATION_ALLOWED');
}

export async function verifyEligibilityPaymentRuntimeRole(
  input: {
    readonly connectionString: string;
    readonly runtimeRoleName: string;
    readonly restoreDatabase: string;
    readonly tenantKey: string;
    readonly confirmation: string;
    readonly matrixVersion: string;
    readonly matrixSha256: string;
  },
  createClient: EligibilityPaymentRuntimeProbeClientFactory = (connectionString) =>
    new Client({
      connectionString,
      application_name: 'phub-eligibility-payment-runtime-probe',
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
    }) as unknown as EligibilityPaymentRuntimeProbeClient,
): Promise<void> {
  assertRestoreDatabase(input.restoreDatabase);
  assertCloneConnectionString(input.connectionString, input.restoreDatabase);
  if (input.confirmation !== ELIGIBILITY_PAYMENT_RUNTIME_PROBE_CONFIRMATION) {
    fail('ELIGIBILITY_PAYMENT_RUNTIME_CONFIRMATION_INVALID');
  }
  assertEligibilityPaymentAclMatrixBinding({
    version: input.matrixVersion,
    sha256: input.matrixSha256,
  });
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.tenantKey)) {
    fail('ELIGIBILITY_PAYMENT_RUNTIME_TENANT_KEY_INVALID');
  }

  const client = createClient(input.connectionString);
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query(`select pg_catalog.set_config('search_path', 'pg_catalog', false)`);
    await client.query('begin');
    transactionOpen = true;
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '10s'");
    const identity = (await client.query(
      `select pg_catalog.current_database() as database_name,
              session_user = current_user as session_identity_exact,
              current_user = $1::name as runtime_identity_exact`,
      [input.runtimeRoleName],
    )) as {
      readonly rows: {
        readonly database_name: string;
        readonly session_identity_exact: boolean;
        readonly runtime_identity_exact: boolean;
      }[];
    };
    const identityRow = identity.rows[0];
    if (
      identityRow?.database_name !== input.restoreDatabase ||
      !identityRow.session_identity_exact ||
      !identityRow.runtime_identity_exact
    ) {
      fail('ELIGIBILITY_PAYMENT_RUNTIME_DATABASE_BOUNDARY_INVALID');
    }

    const tenantResult = (await client.query(
      `select id::text as tenant_id
         from identity.tenants
        where active and tenant_key = $1
        limit 1`,
      [input.tenantKey],
    )) as { readonly rows: { readonly tenant_id: string }[] };
    const tenantId = tenantResult.rows[0]?.tenant_id;
    if (!tenantId) fail('ELIGIBILITY_PAYMENT_RUNTIME_TENANT_REQUIRED');
    await client.query(`select pg_catalog.set_config('app.tenant_id', $1, true)`, [tenantId]);

    for (const relation of ELIGIBILITY_PAYMENT_ACL_RELATIONS) {
      const qualified = `${relation.schemaName}.${relation.relationName}`;
      await client.query(`select count(*)::text as row_count from ${qualified} where false`);
      if ((relation.runtimePrivileges as readonly string[]).includes('INSERT')) {
        await client.query(`insert into ${qualified} select * from ${qualified} where false`);
      }
      if ((relation.runtimePrivileges as readonly string[]).includes('UPDATE')) {
        await client.query(`update ${qualified} set tenant_id = tenant_id where false`);
      }
    }

    const idempotencyKey = `acl-probe-${randomUUID()}`;
    await client.query(
      `insert into eligibility.policy_commands (
         tenant_id, idempotency_key, request_hash, result_payload
       ) values ($1::uuid, $2, $3, '{}'::jsonb)`,
      [tenantId, idempotencyKey, '0'.repeat(64)],
    );
    const localRead = (await client.query(
      `select count(*)::text as row_count
         from eligibility.policy_commands
        where tenant_id = $1::uuid and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    )) as { readonly rows: { readonly row_count: string }[] };
    if (localRead.rows[0]?.row_count !== '1') {
      fail('ELIGIBILITY_PAYMENT_RUNTIME_LOCAL_DML_FAILED');
    }

    const otherTenantId =
      tenantId === '00000000-0000-0000-0000-000000000001'
        ? '00000000-0000-0000-0000-000000000002'
        : '00000000-0000-0000-0000-000000000001';
    await client.query(`select pg_catalog.set_config('app.tenant_id', $1, true)`, [otherTenantId]);
    const hidden = (await client.query(
      `select count(*)::text as row_count
         from eligibility.policy_commands
        where tenant_id = $1::uuid and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    )) as { readonly rows: { readonly row_count: string }[] };
    if (hidden.rows[0]?.row_count !== '0') {
      fail('ELIGIBILITY_PAYMENT_RUNTIME_CROSS_TENANT_READ_VISIBLE');
    }

    await expectInsufficientPrivilege(
      client,
      'cross_tenant_write',
      `insert into eligibility.policy_commands (
         tenant_id, idempotency_key, request_hash, result_payload
       ) values ($1::uuid, $2, $3, '{}'::jsonb)`,
      [tenantId, `acl-cross-${randomUUID()}`, '1'.repeat(64)],
    );
    await expectInsufficientPrivilege(
      client,
      'delete_forbidden',
      `delete from eligibility.policy_commands where false`,
    );
    await expectInsufficientPrivilege(
      client,
      'schema_create_forbidden',
      `create table eligibility.runtime_acl_probe_forbidden (id integer)`,
    );
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
