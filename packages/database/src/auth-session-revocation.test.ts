import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { revokeAllRefreshSessionsForUserInTransaction } from './auth-repository.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  reason: 'CREDENTIAL_RESET' as const,
  correlationId: 'synthetic-revoke-all',
};
function connection(
  options: {
    tenant?: string | null;
    userExists?: boolean;
    count?: number;
    auditError?: boolean;
  } = {},
) {
  const query = vi.fn((sql: string) => {
    if (sql.includes('current_setting'))
      return Promise.resolve({
        rows: [{ tenant_id: options.tenant === undefined ? input.tenantId : options.tenant }],
      });
    if (sql.startsWith('select id from identity.users'))
      return Promise.resolve({ rows: options.userExists === false ? [] : [{ id: input.userId }] });
    if (sql.startsWith('update identity.refresh_sessions'))
      return Promise.resolve({ rows: [], rowCount: options.count ?? 3 });
    if (sql.includes('insert into audit.audit_log') && options.auditError)
      return Promise.reject(new Error('synthetic-audit-failure'));
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { client: { query } as unknown as PoolClient, query };
}
describe('internal account-wide refresh revocation in caller transaction', () => {
  it('locks exact user before revoking every family and auditing once without credentials', async () => {
    const { client, query } = connection();
    expect(await revokeAllRefreshSessionsForUserInTransaction(client, input)).toEqual({
      outcome: 'revoked',
      revokedSessionCount: 3,
    });
    expect(query).toHaveBeenCalledWith(
      'select id from identity.users where tenant_id = $1 and id = $2 for update',
      [input.tenantId, input.userId],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('user_id = $2 and revoked_at is null'),
      [input.tenantId, input.userId, input.reason],
    );
    const calls = query.mock.calls.map(([sql]) => sql);
    expect(calls.findIndex((sql) => sql.includes('for update'))).toBeLessThan(
      calls.findIndex((sql) => sql.startsWith('update identity.refresh_sessions')),
    );
    expect(calls.filter((sql) => sql.includes('insert into audit.audit_log'))).toHaveLength(1);
    expect(calls.join(' ')).not.toMatch(/token_hash|family_id|phone|email|status = 'ACTIVE'/);
    expect(calls).not.toContain('begin');
    expect(calls).not.toContain('commit');
    expect(calls).not.toContain('rollback');
    expect(calls.at(-1)).toBe('release savepoint phub_revoke_all_sessions');
  });
  it.each([null, 'another-tenant'])(
    'denies absent or mismatched transaction tenant %s before writes',
    async (tenant) => {
      const { client, query } = connection({ tenant });
      await expect(revokeAllRefreshSessionsForUserInTransaction(client, input)).rejects.toThrow(
        'AUTH_SESSION_TRANSACTION_CONTEXT_INVALID',
      );
      expect(
        query.mock.calls.some(([sql]) => sql.startsWith('update') || sql.includes('for update')),
      ).toBe(false);
    },
  );
  it('does not select another account or mutate/audit a missing user', async () => {
    const { client, query } = connection({ userExists: false });
    expect(await revokeAllRefreshSessionsForUserInTransaction(client, input)).toEqual({
      outcome: 'not_found',
    });
    expect(
      query.mock.calls.some(([sql]) => sql.startsWith('update') || sql.startsWith('insert')),
    ).toBe(false);
  });
  it('reports zero changes without a false revocation audit on no-op/repeat', async () => {
    const { client, query } = connection({ count: 0 });
    expect(await revokeAllRefreshSessionsForUserInTransaction(client, input)).toEqual({
      outcome: 'revoked',
      revokedSessionCount: 0,
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('insert into audit'))).toBe(false);
  });
  it('propagates audit failure to the outer transaction without committing or hiding it', async () => {
    const { client, query } = connection({ auditError: true });
    await expect(revokeAllRefreshSessionsForUserInTransaction(client, input)).rejects.toThrow(
      'synthetic-audit-failure',
    );
    expect(
      query.mock.calls.some(([sql]) => sql === 'commit' || sql.startsWith('release savepoint')),
    ).toBe(false);
  });
  it.each(['from-browser', ''])(
    'rejects unrecognized runtime reason %s before touching the database',
    async (reason) => {
      const { client, query } = connection();
      await expect(
        revokeAllRefreshSessionsForUserInTransaction(client, {
          ...input,
          reason: reason as typeof input.reason,
        }),
      ).rejects.toThrow('AUTH_SESSION_REVOKE_REASON_INVALID');
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'contains pii@example.test', 'a'.repeat(129)])(
    'rejects unsafe correlation metadata',
    async (correlationId) => {
      const { client, query } = connection();
      await expect(
        revokeAllRefreshSessionsForUserInTransaction(client, { ...input, correlationId }),
      ).rejects.toThrow('AUTH_SESSION_CORRELATION_INVALID');
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('requires an explicit transaction before reaching tenant/account writes', async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error('SAVEPOINT can only be used in transaction blocks'));
    await expect(
      revokeAllRefreshSessionsForUserInTransaction({ query } as unknown as PoolClient, input),
    ).rejects.toThrow('SAVEPOINT');
    expect(query).toHaveBeenCalledOnce();
  });
});
