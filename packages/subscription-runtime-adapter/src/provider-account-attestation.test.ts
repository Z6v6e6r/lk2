import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_ACCOUNT_ATTESTATION_PATH,
  ProviderAccountOwnerClient,
  ProviderAccountOwnerError,
  parseProviderAccountAttestation,
  parseProviderAccountAttestationRequest,
  providerAccountAttestationRequestSha256,
} from './provider-account-attestation.js';

const operationId = '6b0f1a52-5d1e-4c1e-9a3b-0c8e2f6d4a11';
const now = Date.parse('2026-11-08T10:00:00.000Z');
const subscription = {
  clientSubscriptionId: 'sub-1001',
  productId: '8bf334ba-3050-4017-b40a-7eef2db1eb16',
  title: 'Абонемент 10 игр',
  state: 'ACTIVE',
  remainingUnits: 7,
  validUntil: '2027-01-01T00:00:00.000Z',
};
const response = (extra: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  operationId,
  providerTenantKey: 'iSkq6G',
  providerClientId: 'client-42',
  subscriptions: [subscription],
  attestedAt: '2026-11-08T10:00:01.000Z',
  ...extra,
});
const envelope = {
  actorDelegation: 'header.payload.signature',
  actorToken: { token: 'viva-access-token-0123456789', expiresAt: '2026-11-08T10:05:00.000Z' },
  correlationId: 'corr-12345678',
};

describe('provider account attestation request', () => {
  it('accepts the two exact shapes and rejects extras', () => {
    expect(parseProviderAccountAttestationRequest({ contractVersion: 1, operationId })).toEqual({
      contractVersion: 1,
      operationId,
    });
    expect(
      parseProviderAccountAttestationRequest({
        contractVersion: 1,
        operationId,
        target: { exerciseId: 'ex-77' },
      }).target,
    ).toEqual({ exerciseId: 'ex-77' });
    for (const bad of [
      { contractVersion: 2, operationId },
      { contractVersion: 1, operationId: 'nope' },
      { contractVersion: 1, operationId, providerClientId: 'client-42' },
      { contractVersion: 1, operationId, target: { exerciseId: 'ex', extra: 1 } },
      { contractVersion: 1, operationId, target: { exerciseId: 'a b' } },
    ])
      expect(() => parseProviderAccountAttestationRequest(bad)).toThrow(ProviderAccountOwnerError);
  });

  it('binds the canonical digest to target presence', () => {
    const plain = providerAccountAttestationRequestSha256({ contractVersion: 1, operationId });
    const target = providerAccountAttestationRequestSha256({
      contractVersion: 1,
      operationId,
      target: { exerciseId: 'ex-77' },
    });
    expect(plain).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(target).not.toBe(plain);
  });
});

describe('provider account attestation response', () => {
  const request = { contractVersion: 1 as const, operationId };

  it('parses an exact owner response', () => {
    expect(parseProviderAccountAttestation(response(), request, now)).toMatchObject({
      providerClientId: 'client-42',
      subscriptions: [{ clientSubscriptionId: 'sub-1001', remainingUnits: 7 }],
    });
  });

  it.each([
    ['another operation', { operationId: 'a0f1a52b-5d1e-4c1e-9a3b-0c8e2f6d4a11' }],
    ['another provider tenant', { providerTenantKey: 'other' }],
    ['an unexpected key', { phone: '79000000000' }],
    ['a target proof without a target', { targetProof: {} }],
    ['a stale attestation', { attestedAt: '2026-11-08T09:50:00.000Z' }],
    ['a malformed client id', { providerClientId: 'bad id' }],
    ['duplicate subscriptions', { subscriptions: [subscription, subscription] }],
    ['a raw provider field', { subscriptions: [{ ...subscription, raw: {} }] }],
    ['a negative balance', { subscriptions: [{ ...subscription, remainingUnits: -1 }] }],
    ['an unknown state', { subscriptions: [{ ...subscription, state: 'DELETED' }] }],
    [
      'too many subscriptions',
      {
        subscriptions: Array.from({ length: 51 }, (_, i) => ({
          ...subscription,
          clientSubscriptionId: `sub-${i}`,
        })),
      },
    ],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseProviderAccountAttestation(response(patch), request, now)).toThrow(
      ProviderAccountOwnerError,
    );
  });

  it('accepts NOT_ACTIVATED, an unnamed subscription and any owner duration', () => {
    const parsed = parseProviderAccountAttestation(
      response({
        subscriptions: [{ ...subscription, state: 'NOT_ACTIVATED', title: null, productId: null }],
      }),
      request,
      now,
    );
    expect(parsed.subscriptions[0]).toMatchObject({ state: 'NOT_ACTIVATED', title: null });
    const targeted = { ...request, target: { exerciseId: 'ex-77' } };
    const proof = {
      exerciseId: 'ex-77',
      startsAt: '2026-11-09T10:00:00.000Z',
      durationMinutes: 120,
      ownedClientSubscriptionIds: ['sub-1001'],
    };
    expect(
      parseProviderAccountAttestation(response({ targetProof: proof }), targeted, now).targetProof
        ?.durationMinutes,
    ).toBe(120);
    for (const durationMinutes of [0, 1441, 60.5])
      expect(() =>
        parseProviderAccountAttestation(
          response({ targetProof: { ...proof, durationMinutes } }),
          targeted,
          now,
        ),
      ).toThrow(ProviderAccountOwnerError);
  });

  it('requires a target proof for a targeted request', () => {
    const targeted = { ...request, target: { exerciseId: 'ex-77' } };
    const proof = {
      exerciseId: 'ex-77',
      startsAt: '2026-11-09T10:00:00.000Z',
      durationMinutes: 60,
      ownedClientSubscriptionIds: ['sub-1001'],
    };
    expect(
      parseProviderAccountAttestation(response({ targetProof: proof }), targeted, now).targetProof,
    ).toEqual(proof);
    expect(() => parseProviderAccountAttestation(response(), targeted, now)).toThrow();
    // The proof may name owned subscriptions beyond the truncated display list (lk#303).
    expect(
      parseProviderAccountAttestation(
        response({ targetProof: { ...proof, ownedClientSubscriptionIds: ['sub-unlisted'] } }),
        targeted,
        now,
      ).targetProof?.ownedClientSubscriptionIds,
    ).toEqual(['sub-unlisted']);
    expect(() =>
      parseProviderAccountAttestation(
        response({ targetProof: { ...proof, exerciseId: 'ex-other' } }),
        targeted,
        now,
      ),
    ).toThrow();
  });
});

describe('ProviderAccountOwnerClient', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const client = (fetchImplementation: typeof fetch) =>
    new ProviderAccountOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation,
      now: () => now,
    });

  it('sends only the fixed route, headers and body', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(response())));
    await client(fetchImpl).attest({ contractVersion: 1, operationId }, envelope);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://padlhub.su${PROVIDER_ACCOUNT_ATTESTATION_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({ contractVersion: 1, operationId });
    expect(init.headers).toMatchObject({
      'X-Subscription-Actor-Delegation': envelope.actorDelegation,
      'X-Subscription-Actor-Token': envelope.actorToken.token,
      'X-Correlation-ID': envelope.correlationId,
    });
  });

  it('maps owner 401/403 to FORBIDDEN without opening the circuit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ code: 'PROVIDER_ACCOUNT_FORBIDDEN' }, 403)),
    );
    const c = client(fetchImpl);
    for (let i = 0; i < 4; i += 1)
      await expect(c.attest({ contractVersion: 1, operationId }, envelope)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT_FORBIDDEN',
      });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([400, 409])('maps owner %i to INVALID without opening the circuit', async (status) => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ code: 'PROVIDER_ACCOUNT_INVALID' }, status)),
    );
    const c = client(fetchImpl);
    for (let i = 0; i < 4; i += 1)
      await expect(c.attest({ contractVersion: 1, operationId }, envelope)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT_INVALID',
      });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('opens the circuit after three unavailable responses', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' }, 503)),
    );
    const c = client(fetchImpl);
    for (let i = 0; i < 4; i += 1)
      await expect(c.attest({ contractVersion: 1, operationId }, envelope)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT_UNAVAILABLE',
      });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized body', async () => {
    const big = vi.fn(() =>
      Promise.resolve(new Response('x'.repeat(40000), { status: 200 })),
    ) as unknown as typeof fetch;
    await expect(
      client(big).attest({ contractVersion: 1, operationId }, envelope),
    ).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_INVALID' });
  });

  it('times out with UNAVAILABLE', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    ) as unknown as typeof fetch;
    const c = new ProviderAccountOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 100,
      fetchImplementation: hang,
      now: () => now,
    });
    await expect(c.attest({ contractVersion: 1, operationId }, envelope)).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_UNAVAILABLE',
    });
  });

  it('refuses an expired actor token and a non-https production base', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      client(fetchImpl).attest(
        { contractVersion: 1, operationId },
        { ...envelope, actorToken: { ...envelope.actorToken, expiresAt: '2026-11-08T09:00:00Z' } },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_INVALID' });
    expect(
      () =>
        new ProviderAccountOwnerClient({
          baseUrl: 'http://padlhub.su/',
          environment: 'production',
          timeoutMs: 1000,
        }),
    ).toThrow(ProviderAccountOwnerError);
  });
});
