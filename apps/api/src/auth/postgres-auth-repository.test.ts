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
