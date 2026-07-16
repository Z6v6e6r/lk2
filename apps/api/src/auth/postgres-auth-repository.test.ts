import { describe, expect, it, vi } from 'vitest';

import { PostgresAuthRepository } from './postgres-auth-repository.js';

const tenantId = 'cd6ae70a-ef7a-456f-8bd5-0eba4130be30';
const userId = 'ccac6bfe-c489-4c71-8adf-cc736f49d48f';

describe('PostgresAuthRepository Viva delegations', () => {
  it('transfers a repeated issuer/subject delegation to the canonical user', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    };
    const repository = new PostgresAuthRepository(pool as never);

    await repository.saveVivaDelegation({
      tenantId,
      userId,
      issuer: 'https://kc.vivacrm.ru/realms/clients',
      subject: 'stable-oauth-subject',
      refreshTokenCiphertext: 'encrypted-refresh-token',
      encryptionKeyVersion: 'v1',
      grantedScopes: ['openid', 'profile'],
      correlationId: 'oauth-repeat-correlation',
    });

    const statements = query.mock.calls.map(([text]) => String(text));
    const deleteIndex = statements.findIndex((text) =>
      text.includes('delete from integration.user_delegations'),
    );
    const upsertIndex = statements.findIndex((text) =>
      text.includes('insert into integration.user_delegations'),
    );

    expect(statements).toContain('select pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(upsertIndex).toBeGreaterThan(deleteIndex);
    expect(statements[deleteIndex]).toContain("provider = 'VIVA'");
    expect(statements[deleteIndex]).toContain('subject <> $4');
    expect(statements[upsertIndex]).toContain('on conflict (tenant_id, issuer, subject)');
    expect(statements[upsertIndex]).toContain('user_id = excluded.user_id');
    expect(statements[upsertIndex]).not.toContain(
      'on conflict (tenant_id, user_id, provider, issuer)',
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
