import { describe, expect, it, vi } from 'vitest';

import { createLk1OwnedSubscriptionReader } from './lk1-owned-subscription-reader.js';

const clientId = '7c0d6a62-1f3e-4b7a-9c11-2a6f0b1d9e01';
const subscriptionId = '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const input = {
  accessToken: 'viva-access-token-0123456789',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  actor: {
    tenantId: '22222222-2222-4222-8222-222222222222',
    userId: '11111111-1111-4111-8111-111111111111',
    sessionId: '33333333-3333-4333-8333-333333333333',
    tenantKey: 'local-padel',
  },
  providerExerciseId: 'ex-77',
  providerClientId: clientId,
  providerSubscriptionId: subscriptionId,
  startsAt: '2026-11-09T13:00:00+03:00',
  durationMinutes: 60 as const,
  signal: new AbortController().signal,
  correlationId: 'join-conditions-0001',
};

function setup(patch: Record<string, unknown> = {}, proof: Record<string, unknown> = {}) {
  const issuer = {
    issueProviderAccountAttestation: vi.fn<(input: unknown) => Promise<string>>(() =>
      Promise.resolve('signed.jwt.value'),
    ),
  };
  const client = {
    attest: vi.fn((request: { operationId: string }) =>
      Promise.resolve({
        contractVersion: 1 as const,
        operationId: request.operationId,
        providerTenantKey: 'iSkq6G' as const,
        providerClientId: clientId.toUpperCase(),
        subscriptions: [],
        attestedAt: '2026-11-08T10:00:00.000Z',
        targetProof: {
          exerciseId: 'ex-77',
          startsAt: '2026-11-09T10:00:00.000Z',
          durationMinutes: 60,
          ownedClientSubscriptionIds: [subscriptionId],
          eligibleClientSubscriptionIds: [subscriptionId],
          ...proof,
        },
        ...patch,
      }),
    ),
  };
  return { issuer, client, read: createLk1OwnedSubscriptionReader({ issuer, client }) };
}

describe('createLk1OwnedSubscriptionReader', () => {
  it('binds the same request and actor token to the delegation and the LK1 call', async () => {
    const { issuer, client, read } = setup();
    const result = await read(input);
    const issued = issuer.issueProviderAccountAttestation.mock.calls[0]![0] as {
      request: { operationId: string; target: { exerciseId: string } };
      actorToken: string;
    };
    const [request, envelope] = client.attest.mock.calls[0] as unknown as [
      { operationId: string },
      { actorDelegation: string; actorToken: { token: string } },
    ];
    expect(issued.request).toBe(request);
    expect(issued.request.target).toEqual({ exerciseId: 'ex-77' });
    expect(issued.actorToken).toBe(input.accessToken);
    expect((issued as unknown as { tenantKey: string }).tenantKey).toBe('iSkq6G');
    expect(envelope.actorToken.token).toBe(input.accessToken);
    expect(envelope.actorDelegation).toBe('signed.jwt.value');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // Join conditions resolve twice: a fresh operation id must not change the fingerprint.
    expect((await read(input)).fingerprint).toBe(result.fingerprint);
  });

  it('fails closed without a mapped exercise and never calls LK1', async () => {
    const { client, read } = setup();
    await expect(read({ ...input, providerExerciseId: null })).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE',
    });
    expect(client.attest).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another Viva client',
      { providerClientId: '9f9f9f9f-1f3e-4b7a-9c11-2a6f0b1d9e01' },
      {},
      'GAME_JOIN_CONDITIONS_SELECTION_INVALID',
    ],
    [
      'a foreign subscription',
      {},
      { ownedClientSubscriptionIds: ['other-sub'] },
      'GAME_JOIN_CONDITIONS_SELECTION_INVALID',
    ],
    [
      'another start',
      {},
      { startsAt: '2026-11-09T11:00:00.000Z' },
      'GAME_JOIN_CONDITIONS_REVISION_CHANGED',
    ],
    ['another duration', {}, { durationMinutes: 90 }, 'GAME_JOIN_CONDITIONS_REVISION_CHANGED'],
    [
      'an owned but inapplicable subscription',
      {},
      { eligibleClientSubscriptionIds: [] },
      'GAME_JOIN_CONDITIONS_SELECTION_INVALID',
    ],
    ['a missing proof', { targetProof: undefined }, {}, 'GAME_JOIN_CONDITIONS_REVISION_CHANGED'],
  ])('rejects %s', async (_name, patch, proof, code) => {
    const { read } = setup(patch, proof);
    await expect(read(input)).rejects.toMatchObject({ code });
  });

  it('propagates owner errors unchanged', async () => {
    const { client, read } = setup();
    client.attest.mockRejectedValueOnce(new Error('PROVIDER_ACCOUNT_UNAVAILABLE'));
    await expect(read(input)).rejects.toThrow('PROVIDER_ACCOUNT_UNAVAILABLE');
  });
});
