import { describe, expect, it, vi } from 'vitest';
import {
  ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
} from '@phub/database';

import {
  ELIGIBILITY_PAYMENT_RUNTIME_PROBE_CONFIRMATION,
  EligibilityPaymentRuntimeProbeError,
  verifyEligibilityPaymentRuntimeRole,
  type EligibilityPaymentRuntimeProbeClient,
} from './eligibility-payment-runtime-role-probe.js';

function createClient(input: {
  readonly crossTenantVisible?: boolean;
  readonly allowForbidden?: boolean;
  readonly wrongDatabase?: boolean;
}) {
  const queries: string[] = [];
  const connect = vi.fn(() => Promise.resolve());
  let tenantContextCount = 0;
  const query = vi.fn((text: string) => {
    queries.push(text);
    if (text.includes('current_database() as database_name')) {
      return Promise.resolve({
        rows: [
          {
            database_name: input.wrongDatabase ? 'padlhub' : 'phub_restore_123_1',
            session_identity_exact: true,
            runtime_identity_exact: true,
          },
        ],
      });
    }
    if (text.includes('from identity.tenants')) {
      return Promise.resolve({ rows: [{ tenant_id: '11111111-1111-1111-1111-111111111111' }] });
    }
    if (text.includes("set_config('app.tenant_id'")) tenantContextCount += 1;
    if (text.includes('from eligibility.policy_commands') && text.includes('idempotency_key')) {
      return Promise.resolve({
        rows: [{ row_count: tenantContextCount > 1 && !input.crossTenantVisible ? '0' : '1' }],
      });
    }
    const forbidden =
      text.startsWith('delete from ') ||
      text.startsWith('create table ') ||
      (text.includes('insert into eligibility.policy_commands') && tenantContextCount > 1);
    if (forbidden && !input.allowForbidden) {
      throw Object.assign(new Error('insufficient privilege'), { code: '42501' });
    }
    return Promise.resolve({ rows: [] });
  });
  const client: EligibilityPaymentRuntimeProbeClient = {
    connect,
    query,
    end: vi.fn(() => Promise.resolve()),
  };
  return { client, queries, connect };
}

const exactInput = {
  connectionString: 'postgresql://runtime@postgres:5432/phub_restore_123_1',
  runtimeRoleName: 'phub_runtime',
  restoreDatabase: 'phub_restore_123_1',
  tenantKey: 'local-padel',
  confirmation: ELIGIBILITY_PAYMENT_RUNTIME_PROBE_CONFIRMATION,
  matrixVersion: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  matrixSha256: ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
};

describe('eligibility/payment runtime role probe', () => {
  it('proves exact matrix access and cross-tenant denial, then rolls back', async () => {
    const { client, queries } = createClient({});
    await expect(
      verifyEligibilityPaymentRuntimeRole(exactInput, () => client),
    ).resolves.toBeUndefined();
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('insert into eligibility.policy_commands'),
        'rollback to savepoint cross_tenant_write',
        'rollback to savepoint delete_forbidden',
        'rollback to savepoint schema_create_forbidden',
        'rollback',
      ]),
    );
    expect(queries.at(-1)).toBe('rollback');
  });

  it('fails closed on cross-tenant visibility or an allowed forbidden operation', async () => {
    const visible = createClient({ crossTenantVisible: true });
    await expect(
      verifyEligibilityPaymentRuntimeRole(exactInput, () => visible.client),
    ).rejects.toEqual(
      new EligibilityPaymentRuntimeProbeError(
        'ELIGIBILITY_PAYMENT_RUNTIME_CROSS_TENANT_READ_VISIBLE',
      ),
    );
    expect(visible.queries.at(-1)).toBe('rollback');

    const broad = createClient({ allowForbidden: true });
    await expect(
      verifyEligibilityPaymentRuntimeRole(exactInput, () => broad.client),
    ).rejects.toEqual(
      new EligibilityPaymentRuntimeProbeError(
        'ELIGIBILITY_PAYMENT_RUNTIME_FORBIDDEN_OPERATION_ALLOWED',
      ),
    );
    expect(broad.queries.at(-1)).toBe('rollback');
  });

  it('rejects a shared database before any probe DML', async () => {
    const { client, queries } = createClient({ wrongDatabase: true });
    await expect(verifyEligibilityPaymentRuntimeRole(exactInput, () => client)).rejects.toEqual(
      new EligibilityPaymentRuntimeProbeError(
        'ELIGIBILITY_PAYMENT_RUNTIME_DATABASE_BOUNDARY_INVALID',
      ),
    );
    expect(queries.some((query) => query.startsWith('insert into '))).toBe(false);
    expect(queries.at(-1)).toBe('rollback');
  });

  it('rejects a non-compose target before connecting', async () => {
    const { client, connect } = createClient({});
    await expect(
      verifyEligibilityPaymentRuntimeRole(
        { ...exactInput, connectionString: 'postgresql://runtime@staging:5432/phub_restore_123_1' },
        () => client,
      ),
    ).rejects.toThrow('ELIGIBILITY_PAYMENT_RUNTIME_CONNECTION_BOUNDARY_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a different ACL matrix before connecting', async () => {
    const { client, connect } = createClient({});
    await expect(
      verifyEligibilityPaymentRuntimeRole(
        { ...exactInput, matrixSha256: '0'.repeat(64) },
        () => client,
      ),
    ).rejects.toThrow('ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });
});
