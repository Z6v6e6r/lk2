import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ProviderAccountOwnerError } from '../../../../packages/subscription-runtime-adapter/src/provider-account-attestation.js';
import { ProviderAccountMappingConflict } from '../../../../packages/database/src/provider-account-mapping-repository.js';
import {
  registerJoinableSubscriptionsRoutes,
  type JoinableSubscriptionsOptions,
} from './joinable-subscriptions-routes.js';

const tenantId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '33333333-3333-4333-8333-333333333333';
const padlhubSubscriptionId = '44444444-4444-4444-8444-444444444444';

function build(joinable?: JoinableSubscriptionsOptions, authenticated = true) {
  const app = Fastify();
  registerJoinableSubscriptionsRoutes(app, {
    ...(joinable ? { joinable } : {}),
    authenticatedTenantHandlers: [
      (request) => {
        if (authenticated)
          Object.assign(request, { tenantId, padlHubClaims: { sub: userId, sid: sessionId } });
        return Promise.resolve();
      },
    ],
  });
  return app;
}

function deps() {
  const attestation = {
    contractVersion: 1 as const,
    operationId: '',
    providerTenantKey: 'iSkq6G' as const,
    providerClientId: '7c0d6a62-1f3e-4b7a-9c11-2a6f0b1d9e01',
    subscriptions: [
      {
        clientSubscriptionId: 'viva-sub-raw-id',
        productId: null,
        title: 'Абонемент 10 игр',
        state: 'NOT_ACTIVATED' as const,
        remainingUnits: 10,
        validUntil: null,
      },
    ],
    attestedAt: '2026-11-08T10:00:00.000Z',
  };
  const options = {
    client: {
      attest: vi.fn((request: { operationId: string }) =>
        Promise.resolve({ ...attestation, operationId: request.operationId }),
      ),
    },
    issuer: {
      issueProviderAccountAttestation: vi.fn<(input: unknown) => Promise<string>>(() =>
        Promise.resolve('signed.jwt.value'),
      ),
    },
    repository: {
      recordAttestation: vi.fn((input: { subscriptions: readonly object[] }) =>
        Promise.resolve({
          profileMappingId: '55555555-5555-4555-8555-555555555555',
          subscriptions: input.subscriptions.map((item) => ({
            ...(item as (typeof attestation.subscriptions)[number]),
            subscriptionId: padlhubSubscriptionId,
          })),
        }),
      ),
    },
    issueActorToken: vi.fn(() =>
      Promise.resolve({ token: 'viva-access-token-0123456789', expiresAt: '2099-01-01T00:00:00Z' }),
    ),
  };
  return options;
}

describe('GET /subscriptions/joinable', () => {
  it('returns only PadlHub ids from one fresh LK1 attestation', async () => {
    const options = deps();
    const response = await build(options).inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/subscriptions/joinable',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json<{ items: { id: string; state: string }[] }>();
    expect(body.items).toEqual([
      {
        id: padlhubSubscriptionId,
        title: 'Абонемент 10 игр',
        state: 'NOT_ACTIVATED',
        remainingUnits: 10,
        validUntil: null,
      },
    ]);
    expect(response.body).not.toContain('viva-sub-raw-id');
    expect(response.body).not.toContain('7c0d6a62');
    const issued = options.issuer.issueProviderAccountAttestation.mock.calls[0]![0] as {
      tenantKey: string;
      sessionId: string;
      actorToken: string;
    };
    expect(issued).toMatchObject({
      tenantKey: 'iSkq6G',
      sessionId,
      actorToken: 'viva-access-token-0123456789',
    });
    expect(options.issueActorToken).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'local-padel', sessionId, userId }),
    );
  });

  it('is unavailable without composition and requires an actor', async () => {
    expect(
      (await build().inject({ url: '/user/api/v1/local-padel/subscriptions/joinable' })).statusCode,
    ).toBe(503);
    const options = deps();
    expect(
      (
        await build(options, false).inject({
          url: '/user/api/v1/local-padel/subscriptions/joinable',
        })
      ).statusCode,
    ).toBe(401);
    expect(options.client.attest).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ProviderAccountOwnerError('PROVIDER_ACCOUNT_FORBIDDEN', 403),
      403,
      'PROVIDER_ACCOUNT_FORBIDDEN',
    ],
    [
      new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 502),
      502,
      'PROVIDER_ACCOUNT_INVALID',
    ],
    [
      new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 503),
      503,
      'PROVIDER_ACCOUNT_UNAVAILABLE',
    ],
    [new Error('boom'), 503, 'PROVIDER_ACCOUNT_UNAVAILABLE'],
  ])('maps owner failure %#', async (error, status, code) => {
    const options = deps();
    options.client.attest.mockRejectedValueOnce(error);
    const response = await build(options).inject({
      url: '/user/api/v1/local-padel/subscriptions/joinable',
    });
    expect(response.statusCode).toBe(status);
    expect(response.json<{ code: string }>().code).toBe(code);
    expect(options.repository.recordAttestation).not.toHaveBeenCalled();
  });

  it('fails closed on a Viva account already bound to another user', async () => {
    const options = deps();
    options.repository.recordAttestation.mockRejectedValueOnce(
      new ProviderAccountMappingConflict(),
    );
    const response = await build(options).inject({
      url: '/user/api/v1/local-padel/subscriptions/joinable',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('PROVIDER_ACCOUNT_CONFLICT');
  });
});
