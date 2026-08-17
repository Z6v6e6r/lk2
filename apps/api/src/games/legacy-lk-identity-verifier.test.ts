import { describe, expect, it, vi } from 'vitest';

import {
  CupLegacyLkIdentityVerifier,
  LegacyLkIdentityVerificationError,
} from './legacy-lk-identity-verifier.js';

const integrationToken = 'cup-identity-token-at-least-32-characters';

describe('CUP legacy LK identity verifier adapter', () => {
  it('forwards only the bearer and server integration token and validates the signed actor', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          actor: {
            issuer: 'https://kc.vivacrm.ru/realms/clients',
            subject: 'signed-subject',
            clientId: 'viva-client-id',
            phoneNorm: '79000000001',
            name: 'Анна',
            tenantKey: 'local-padel',
            authorizedParty: 'widget',
            verified: true,
            source: 'cup-keycloak-jwt',
          },
          token: { expiresAt: '2026-08-16T19:00:00.000Z' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const verifier = new CupLegacyLkIdentityVerifier({
      url: 'https://cup.example.test/api/internal/lk/identity/verify',
      integrationToken,
      timeoutMs: 1_000,
      fetchImplementation,
    });

    await expect(verifier.verify('Bearer signed-token')).resolves.toEqual({
      issuer: 'https://kc.vivacrm.ru/realms/clients',
      subject: 'signed-subject',
      clientId: 'viva-client-id',
      phoneNorm: '79000000001',
      name: 'Анна',
      tenantKey: 'local-padel',
      authorizedParty: 'widget',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://cup.example.test/api/internal/lk/identity/verify',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer signed-token',
          'X-CUP-Integration-Token': integrationToken,
        },
      }),
    );
  });

  it('distinguishes rejected tokens from verifier outages and malformed success responses', async () => {
    const rejected = new CupLegacyLkIdentityVerifier({
      url: 'https://cup.example.test/verify',
      integrationToken,
      timeoutMs: 1_000,
      fetchImplementation: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    });
    await expect(rejected.verify('Bearer bad')).rejects.toMatchObject({ outcome: 'rejected' });

    const unavailable = new CupLegacyLkIdentityVerifier({
      url: 'https://cup.example.test/verify',
      integrationToken,
      timeoutMs: 1_000,
      fetchImplementation: vi.fn().mockRejectedValue(new Error('network')),
    });
    await expect(unavailable.verify('Bearer token')).rejects.toBeInstanceOf(
      LegacyLkIdentityVerificationError,
    );
    await expect(unavailable.verify('Bearer token')).rejects.toMatchObject({
      outcome: 'unavailable',
    });

    const malformed = new CupLegacyLkIdentityVerifier({
      url: 'https://cup.example.test/verify',
      integrationToken,
      timeoutMs: 1_000,
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, actor: { subject: 'unsigned' } }), {
          status: 200,
        }),
      ),
    });
    await expect(malformed.verify('Bearer token')).rejects.toMatchObject({
      outcome: 'unavailable',
    });
  });
});
