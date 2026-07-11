import { describe, expect, it, vi } from 'vitest';

import { createIdentityAuthRepository } from './auth-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const nextSessionId = '44444444-4444-4444-8444-444444444444';
const currentHash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const future = new Date('2099-01-01T00:00:00.000Z');

type QueryHandler = (text: string, values: readonly unknown[]) => unknown;

function repositoryWithClient(handler: QueryHandler, poolHandler?: QueryHandler) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("set_config('app.tenant_id'")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve(handler(text, values) as never);
  });
  const release = vi.fn();
  const poolQuery = vi.fn((text: string, values: readonly unknown[] = []) =>
    Promise.resolve((poolHandler ?? handler)(text, values)),
  );
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
    query: poolQuery,
  };
  return { repository: createIdentityAuthRepository(pool as never), query, poolQuery, release };
}

describe('identity auth repository', () => {
  it('resolves public tenant key then reads provider config under tenant RLS', async () => {
    const { repository, query } = repositoryWithClient(
      (text) => {
        if (text.includes('from integration.identity_provider_bindings')) {
          return {
            rows: [
              {
                tenant_id: tenantId,
                tenant_key: 'local-padel',
                provider: 'VIVA',
                provider_tenant_key: 'iSkq6G',
              },
            ],
          };
        }
        return { rows: [] };
      },
      () => ({ rows: [{ id: tenantId, tenant_key: 'local-padel' }] }),
    );

    await expect(repository.resolveTenantAuthConfig('local-padel')).resolves.toEqual({
      tenantId,
      tenantKey: 'local-padel',
      provider: 'VIVA',
      providerTenantKey: 'iSkq6G',
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('returns only the public auth user summary', async () => {
    const { repository } = repositoryWithClient((text) => {
      if (text.includes('from identity.users u')) {
        return {
          rows: [
            {
              id: userId,
              tenant_id: tenantId,
              display_name: 'Алексей',
              phone_last_4: '4567',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(repository.getAuthUser(tenantId, userId)).resolves.toEqual({
      id: userId,
      tenantId,
      displayName: 'Алексей',
      phoneLast4: '4567',
    });
  });

  it('creates a user from issuer and subject without using phone as identity', async () => {
    const statements: string[] = [];
    const { repository } = repositoryWithClient((text) => {
      statements.push(text);
      if (text.includes('from integration.external_identity_map e')) return { rows: [] };
      if (text.includes('insert into identity.users')) return { rows: [{ id: userId }] };
      if (text.includes('from identity.users u')) {
        return {
          rows: [
            {
              id: userId,
              tenant_id: tenantId,
              display_name: 'Игрок',
              phone_last_4: '4567',
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.upsertExternalUser({
        tenantId,
        provider: 'VIVA',
        issuer: 'https://kc.vivacrm.ru/realms/clients',
        subject: 'stable-viva-subject',
        displayName: 'Игрок',
        phoneE164: '+79991234567',
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toMatchObject({ id: userId, tenantId });

    const identityLookup = statements.find((text) =>
      text.includes('from integration.external_identity_map e'),
    );
    expect(identityLookup).toContain('e.issuer = $2 and e.subject = $3');
    expect(identityLookup).not.toContain('phone_e164 =');
  });

  it('creates an opaque hashed refresh session with an explicit JWT sid', async () => {
    const { repository, query } = repositoryWithClient((text, values) => {
      if (text.includes('insert into identity.refresh_sessions')) {
        expect(values).toEqual([sessionId, tenantId, userId, sessionId, currentHash, future]);
        return {
          rows: [
            {
              id: sessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      repository.createRefreshSession({
        tenantId,
        userId,
        tokenHash: currentHash,
        expiresAt: future,
        sessionId,
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toEqual({
      id: sessionId,
      tenantId,
      userId,
      familyId: sessionId,
      expiresAt: future.toISOString(),
    });
    expect(query.mock.calls.flat().join(' ')).not.toContain('raw_token');
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('insert into audit.audit_log') &&
          (values as readonly unknown[]).includes('test-correlation-123'),
      ),
    ).toBe(true);
  });

  it('rotates a refresh session atomically and returns the successor sid', async () => {
    const { repository, query } = repositoryWithClient((text) => {
      if (text.includes('for update of rs')) {
        return {
          rows: [
            {
              id: sessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
              rotated_at: null,
              revoked_at: null,
            },
          ],
        };
      }
      if (text.includes('insert into identity.refresh_sessions')) {
        return {
          rows: [
            {
              id: nextSessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
            },
          ],
        };
      }
      if (text.includes('from identity.users u')) {
        return {
          rows: [
            {
              id: userId,
              tenant_id: tenantId,
              display_name: 'Игрок',
              phone_last_4: '4567',
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.rotateRefreshSession({
        tenantId,
        currentTokenHash: currentHash,
        nextTokenHash: nextHash,
        nextExpiresAt: future,
        nextSessionId,
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toMatchObject({
      outcome: 'rotated',
      session: { id: nextSessionId, tenantId, userId },
      user: { id: userId },
    });
    expect(query.mock.calls.some(([text]) => String(text).includes('replaced_by_session_id'))).toBe(
      true,
    );
  });

  it('revokes the whole refresh family when a rotated token is replayed', async () => {
    const { repository, query } = repositoryWithClient((text) => {
      if (text.includes('for update of rs')) {
        return {
          rows: [
            {
              id: sessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
              rotated_at: new Date(),
              revoked_at: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.rotateRefreshSession({
        tenantId,
        currentTokenHash: currentHash,
        nextTokenHash: nextHash,
        nextExpiresAt: future,
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toEqual({ outcome: 'reuse_detected' });
    expect(query.mock.calls.some(([text]) => String(text).includes('TOKEN_REUSE_DETECTED'))).toBe(
      true,
    );
  });

  it('replays the same successor for an idempotent lost refresh response', async () => {
    const { repository } = repositoryWithClient((text) => {
      if (text.includes('for update of rs')) {
        return {
          rows: [
            {
              id: sessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
              rotated_at: new Date(),
              revoked_at: null,
              recently_rotated: true,
              replaced_by_session_id: nextSessionId,
            },
          ],
        };
      }
      if (text.includes('and token_hash = $3')) {
        return {
          rows: [
            {
              id: nextSessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
            },
          ],
        };
      }
      if (text.includes('from identity.users u')) {
        return {
          rows: [
            {
              id: userId,
              tenant_id: tenantId,
              display_name: 'Игрок',
              phone_last_4: '4567',
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.rotateRefreshSession({
        tenantId,
        currentTokenHash: currentHash,
        nextTokenHash: nextHash,
        nextExpiresAt: future,
        nextSessionId,
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toMatchObject({
      outcome: 'rotated',
      session: { id: nextSessionId },
      user: { id: userId },
    });
  });

  it('reports a short cross-client refresh race without revoking the family', async () => {
    const { repository, query } = repositoryWithClient((text) => {
      if (text.includes('for update of rs')) {
        return {
          rows: [
            {
              id: sessionId,
              tenant_id: tenantId,
              user_id: userId,
              family_id: sessionId,
              expires_at: future,
              rotated_at: new Date(),
              revoked_at: null,
              recently_rotated: true,
              replaced_by_session_id: nextSessionId,
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.rotateRefreshSession({
        tenantId,
        currentTokenHash: currentHash,
        nextTokenHash: 'c'.repeat(64),
        nextExpiresAt: future,
        correlationId: 'test-correlation-123',
      }),
    ).resolves.toEqual({ outcome: 'recent_replay' });
    expect(query.mock.calls.some(([text]) => String(text).includes('TOKEN_REUSE_DETECTED'))).toBe(
      false,
    );
  });

  it('rejects malformed refresh token hashes before touching the database', () => {
    const { repository, query } = repositoryWithClient(() => ({ rows: [] }));
    expect(() =>
      repository.findActiveRefreshSession({ tenantId, tokenHash: 'not-a-sha256' }),
    ).toThrow('REFRESH_TOKEN_HASH_INVALID');
    expect(query).not.toHaveBeenCalled();
  });
});
