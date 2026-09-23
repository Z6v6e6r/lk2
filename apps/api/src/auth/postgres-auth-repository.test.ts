import { describe, expect, it, vi } from 'vitest';

import { PostgresAuthRepository } from './postgres-auth-repository.js';

const tenantId = 'cd6ae70a-ef7a-456f-8bd5-0eba4130be30';
const userId = 'ccac6bfe-c489-4c71-8adf-cc736f49d48f';
const sessionFamilyId = 'a46bcff8-d5a9-4bf0-98a8-daa8c7f80e5c';

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

  it('records both phone-login legal acceptances and an audit event', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    };
    const repository = new PostgresAuthRepository(pool as never);

    await repository.recordPhoneLegalAcceptances({
      tenantId,
      userId,
      publicOfferVersion: '2026-07-18',
      personalDataPolicyVersion: '2026-07-18',
      correlationId: 'phone-legal-correlation',
    });

    const statements = query.mock.calls.map(([text]) => String(text));
    expect(statements.some((text) => text.includes("'PHONE_OTP'"))).toBe(true);
    expect(statements.some((text) => text.includes('PHONE_OTP_LEGAL_ACCEPTANCE_RECORDED'))).toBe(
      true,
    );
    expect(statements).toContain('commit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('atomically replaces a recovery delegation only for the active mapped session family', async () => {
    const query = vi.fn((text: string) =>
      Promise.resolve({
        rows: [],
        rowCount: text.includes('from identity.refresh_sessions') ? 1 : 1,
      }),
    );
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    };
    const repository = new PostgresAuthRepository(pool as never);

    await expect(
      repository.saveVivaDelegationForActiveSession({
        tenantId,
        userId,
        sessionFamilyId,
        issuer: 'https://kc.vivacrm.ru/realms/clients',
        subject: 'stable-oauth-subject',
        refreshTokenCiphertext: 'encrypted-refresh-token',
        encryptionKeyVersion: 'v1',
        grantedScopes: ['openid'],
        correlationId: 'oauth-recovery-active-family',
      }),
    ).resolves.toBe(true);

    const statements = query.mock.calls.map(([text]) => String(text));
    const activeCheck = statements.find((text) => text.includes('from identity.refresh_sessions'));
    expect(activeCheck).toContain('rs.family_id = $2');
    expect(activeCheck).toContain("e.provider = 'VIVA'");
    expect(activeCheck).toContain("u.status = 'ACTIVE'");
    expect(activeCheck).toContain('for update of rs, u, e');
    expect(
      statements.some((text) => text.includes('insert into integration.user_delegations')),
    ).toBe(true);
    expect(statements).toContain('commit');
  });

  it('does not replace a recovery delegation after its session family is revoked', async () => {
    const query = vi.fn((text: string) =>
      Promise.resolve({
        rows: [],
        rowCount: text.includes('from identity.refresh_sessions') ? 0 : 1,
      }),
    );
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = new PostgresAuthRepository(pool as never);

    await expect(
      repository.saveVivaDelegationForActiveSession({
        tenantId,
        userId,
        sessionFamilyId,
        issuer: 'https://kc.vivacrm.ru/realms/clients',
        subject: 'stable-oauth-subject',
        refreshTokenCiphertext: 'encrypted-refresh-token',
        encryptionKeyVersion: 'v1',
        grantedScopes: ['openid'],
        correlationId: 'oauth-recovery-revoked-family',
      }),
    ).resolves.toBe(false);

    const statements = query.mock.calls.map(([text]) => String(text));
    expect(
      statements.some((text) => text.includes('insert into integration.user_delegations')),
    ).toBe(false);
    expect(statements).toContain('commit');
  });

  it('revokes the PadlHub session family and Viva delegation in one transaction', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('from integration.identity_provider_bindings')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: tenantId,
              tenant_key: 'local-padel',
              provider: 'VIVA',
              provider_tenant_key: 'iSkq6G',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('select family_id, user_id')) {
        return Promise.resolve({
          rows: [{ family_id: sessionFamilyId, user_id: userId }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: tenantId, tenant_key: 'local-padel' }],
        rowCount: 1,
      }),
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = new PostgresAuthRepository(pool as never);

    await expect(
      repository.revokeSessionAndVivaDelegation(
        'local-padel',
        'a'.repeat(64),
        'oauth-logout-atomic-correlation',
      ),
    ).resolves.toBe(true);

    const statements = query.mock.calls.map(([text]) => String(text));
    const sessionUpdate = statements.findIndex((text) =>
      text.includes('update identity.refresh_sessions'),
    );
    const delegationUpdate = statements.findIndex((text) =>
      text.includes('update integration.user_delegations'),
    );
    expect(sessionUpdate).toBeGreaterThan(-1);
    expect(delegationUpdate).toBeGreaterThan(sessionUpdate);
    expect(statements.filter((text) => text === 'begin')).toHaveLength(2);
    expect(statements.filter((text) => text === 'commit')).toHaveLength(2);
  });
});

describe('PostgresAuthRepository durable client access', () => {
  function repositoryWithProfile(profile: {
    readonly roles: string[];
    readonly permissions: string[];
    readonly hasProfile?: boolean;
  }) {
    const query = vi.fn().mockImplementation((text: string) => {
      if (text.includes('from identity.users u')) {
        return Promise.resolve({
          rows: [{ ...profile, has_profile: profile.hasProfile ?? true }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const repository = new PostgresAuthRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);
    return { repository, query };
  }

  it('creates the missing row for an account registered after the last backfill', async () => {
    const { repository, query } = repositoryWithProfile({
      // What the coalesce returns when `identity.user_access_profiles` has no row for the account.
      roles: ['client'],
      permissions: ['profile.read'],
      hasProfile: false,
    });

    await expect(
      repository.ensureClientPermissions({
        tenantId,
        userId,
        permissions: ['profile.read', 'chat.direct.create'],
        correlationId: 'beta-access-new-account-correlation',
      }),
    ).resolves.toEqual({ roles: ['client'], permissions: ['chat.direct.create', 'profile.read'] });

    const statements = query.mock.calls.map(([text]) => String(text));
    const upsertIndex = statements.findIndex((text) =>
      text.includes('insert into identity.user_access_profiles'),
    );
    const auditIndex = statements.findIndex((text) => text.includes("'USER_ACCESS_CHANGED'"));
    expect(upsertIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(upsertIndex);
    const auditValues = query.mock.calls[auditIndex]?.[1] as readonly unknown[];
    // The audit must not claim the read fallback's defaults were an existing stored grant.
    expect(auditValues[3]).toBe(JSON.stringify({ roles: [], permissions: [] }));
    expect(auditValues[4]).toBe(
      JSON.stringify({ roles: ['client'], permissions: ['chat.direct.create', 'profile.read'] }),
    );
  });

  it('adds the beta catalog without dropping an operator grant and audits the change', async () => {
    const { repository, query } = repositoryWithProfile({
      roles: ['client', 'admin'],
      permissions: ['profile.read', 'notifications.manage'],
    });

    await expect(
      repository.ensureClientPermissions({
        tenantId,
        userId,
        permissions: ['profile.read', 'chat.direct.create', 'games.play'],
        correlationId: 'beta-access-correlation',
      }),
    ).resolves.toEqual({
      roles: ['admin', 'client'],
      permissions: ['chat.direct.create', 'games.play', 'notifications.manage', 'profile.read'],
    });

    const statements = query.mock.calls.map(([text]) => String(text));
    const lockIndex = statements.findIndex((text) =>
      text.includes('select pg_advisory_xact_lock(hashtextextended($1, 0))'),
    );
    expect(lockIndex).toBeGreaterThan(-1);
    const readIndex = statements.findIndex((text) => text.includes('from identity.users u'));
    expect(readIndex).toBeGreaterThan(lockIndex);
    // The lock key is the one both operator writers use for the same account.
    const lockValues = query.mock.calls[lockIndex]?.[1] as readonly unknown[];
    expect(lockValues).toEqual([`user-access:${tenantId}:${userId}`]);
    const read = statements[readIndex] ?? '';
    expect(read).toContain('left join identity.user_access_profiles a');
    expect(read).toContain("u.status = 'ACTIVE'");
    expect(read).toContain("coalesce(a.permissions, array['profile.read']::text[])");
    const upsertIndex = statements.findIndex((text) =>
      text.includes('insert into identity.user_access_profiles'),
    );
    expect(upsertIndex).toBeGreaterThan(readIndex);
    expect(statements[upsertIndex]).toContain('on conflict (tenant_id, user_id) do update set');
    const auditIndex = statements.findIndex((text) => text.includes("'USER_ACCESS_CHANGED'"));
    expect(auditIndex).toBeGreaterThan(upsertIndex);
    const upsertValues = query.mock.calls[upsertIndex]?.[1] as readonly unknown[];
    expect(upsertValues[2]).toEqual(['admin', 'client']);
    expect(upsertValues[3]).toEqual([
      'chat.direct.create',
      'games.play',
      'notifications.manage',
      'profile.read',
    ]);
    // The convergence is a system action, not the account granting itself a right.
    expect(upsertValues[4]).toBeUndefined();
    const auditValues = query.mock.calls[auditIndex]?.[1] as readonly unknown[];
    expect(auditValues[0]).toBe(tenantId);
    expect(auditValues[1]).toBe(userId);
    expect(auditValues[2]).toBe('beta-access-correlation');
    expect(auditValues[3]).toBe(
      JSON.stringify({
        roles: ['client', 'admin'],
        permissions: ['profile.read', 'notifications.manage'],
      }),
    );
    expect(auditValues[4]).toBe(
      JSON.stringify({
        roles: ['admin', 'client'],
        permissions: ['chat.direct.create', 'games.play', 'notifications.manage', 'profile.read'],
      }),
    );
  });

  it('writes nothing when the stored profile already holds every permission', async () => {
    const { repository, query } = repositoryWithProfile({
      roles: ['client'],
      permissions: ['chat.direct.create', 'profile.read'],
    });

    await expect(
      repository.ensureClientPermissions({
        tenantId,
        userId,
        permissions: ['profile.read', 'chat.direct.create'],
        correlationId: 'beta-access-noop-correlation',
      }),
    ).resolves.toEqual({ roles: ['client'], permissions: ['chat.direct.create', 'profile.read'] });

    const statements = query.mock.calls.map(([text]) => String(text));
    expect(
      statements.some((text) => text.includes('insert into identity.user_access_profiles')),
    ).toBe(false);
    expect(statements.some((text) => text.includes('audit.audit_log'))).toBe(false);
    expect(statements).toContain('commit');

    // A repeat for the same account is a pure read of the row the previous call left behind.
    const opens = statements.filter((text) => text === 'begin').length;
    await repository.ensureClientPermissions({
      tenantId,
      userId,
      permissions: ['profile.read', 'chat.direct.create'],
      correlationId: 'beta-access-noop-correlation-2',
    });
    const after = query.mock.calls.map(([text]) => String(text));
    expect(after.filter((text) => text === 'begin')).toHaveLength(opens + 1);
    expect(after.some((text) => text.includes('audit.audit_log'))).toBe(false);
  });

  it('does not invent a profile for an account that is not active', async () => {
    const query = vi.fn().mockImplementation((text: string) => {
      if (text.includes('from identity.users u')) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const repository = new PostgresAuthRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(
      repository.ensureClientPermissions({
        tenantId,
        userId,
        permissions: ['chat.direct.create'],
        correlationId: 'beta-access-inactive-correlation',
      }),
    ).resolves.toBeUndefined();

    const statements = query.mock.calls.map(([text]) => String(text));
    expect(
      statements.some((text) => text.includes('insert into identity.user_access_profiles')),
    ).toBe(false);
  });
});
