import { describe, expect, it, vi } from 'vitest';

import {
  BookedOperationV3Client,
  BookedOperationV3ClientError,
} from './booked-operation-v3-client.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const envelope = {
  actorDelegation: 'delegation-token',
  correlationId: 'corr-join-v3-0001',
  operationId: id(3),
  actorToken: {
    token: 'actor-token-1234567890',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
};
const envelopeWithoutToken = {
  actorDelegation: envelope.actorDelegation,
  correlationId: envelope.correlationId,
  operationId: envelope.operationId,
};
const target = { kind: 'GAME' as const, id: id(1), expectedRevision: 7 };
const preflight = {
  contractVersion: 3 as const,
  action: 'JOIN_GAME' as const,
  target,
  paymentIntent: 'USE_SUBSCRIPTION' as const,
};
const quote = {
  quoteId: id(2),
  operationId: id(3),
  basis: 'SUBSCRIPTION' as const,
  durationMinutes: 90 as const,
  startsAt: '2027-01-10T09:00:00.000Z',
  endsAt: '2027-01-10T10:30:00.000Z',
  amountMinor: 50000,
  currency: 'RUB' as const,
  coveredMinutes: 60,
  surchargeMinor: 50000,
  expiresAt: '2027-01-10T08:55:00.000Z',
  policyVersion: 'policy-7',
  priceDigest: 'sha256:' + 'a'.repeat(64),
};
const settlement = {
  mode: 'SURCHARGE' as const,
  currency: 'RUB' as const,
  toPayMinor: 50000,
  checkoutUrl: 'https://padlhub.su/pay/abc',
  expiresAt: '2027-01-10T08:55:00.000Z',
  state: 'OPEN' as const,
};

function client(response: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const fetchImplementation = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new BookedOperationV3Client({
      baseUrl: 'https://lk1.example/',
      timeoutMs: 1_000,
      fetchImplementation,
    }),
  };
}

describe('booked operation v3 client', () => {
  it('sends a signed preflight and parses a surcharge quote', async () => {
    const { calls, client: api } = client({
      contractVersion: 3,
      nonBinding: true,
      operationId: id(3),
      action: 'JOIN_GAME',
      target,
      quote,
      settlement,
      requestSha256: 'sha256:' + 'f'.repeat(64),
    });
    await expect(api.preflight(preflight, envelope)).resolves.toMatchObject({
      settlement: { toPayMinor: 50000, state: 'OPEN' },
      quote: { durationMinutes: 90 },
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://lk1.example/lk/integrations/v3/booked-operation-preflights');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('X-Subscription-Actor-Delegation')).toBe('delegation-token');
    expect(headers.get('X-Subscription-Actor-Token')).toBe('actor-token-1234567890');
    const body = call.init?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual(preflight);
  });

  it('reads the original operation without an actor token', async () => {
    const { calls, client: api } = client({
      contractVersion: 3,
      operationId: id(3),
      quoteId: id(2),
      requestSha256: 'sha256:' + 'f'.repeat(64),
      status: 'PENDING',
      asOf: '2027-01-10T08:30:00.000Z',
      payment: {
        state: 'PAID',
        toPayMinor: 50000,
        paidMinor: 50000,
        checkoutUrl: null,
        expiresAt: null,
      },
      booking: { state: 'PENDING' },
      visit: { state: 'CONSUMED', usageRef: 'usage-7' },
      reason: 'OWNER_PENDING',
      receipt: null,
    });
    await expect(api.read(id(3), { ...envelopeWithoutToken })).resolves.toMatchObject({
      status: 'PENDING',
      payment: { state: 'PAID' },
      booking: { state: 'PENDING' },
    });
    expect(calls[0]?.url).toBe('https://lk1.example/lk/integrations/v3/booked-operations/' + id(3));
    expect(new Headers(calls[0]?.init?.headers).get('X-Subscription-Actor-Token')).toBeNull();
  });

  it('opens the breaker after three transport failures without a fourth request', async () => {
    const fetchImplementation = vi.fn(() => Promise.reject(new Error('synthetic network failure')));
    const api = new BookedOperationV3Client({
      baseUrl: 'https://lk1.example/',
      timeoutMs: 1_000,
      fetchImplementation,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(api.preflight(preflight, envelope)).rejects.toBeInstanceOf(
        BookedOperationV3ClientError,
      );
    }
    await expect(api.preflight(preflight, envelope)).rejects.toBeInstanceOf(
      BookedOperationV3ClientError,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('counts real HTTP 503 responses in the breaker', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    );
    const api = new BookedOperationV3Client({
      baseUrl: 'https://lk1.example/',
      timeoutMs: 1_000,
      fetchImplementation,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(api.preflight(preflight, envelope)).rejects.toBeInstanceOf(
        BookedOperationV3ClientError,
      );
    }
    await expect(api.preflight(preflight, envelope)).rejects.toBeInstanceOf(
      BookedOperationV3ClientError,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('cancels idempotently and rejects a non-https owner or a missing actor token', async () => {
    const { client: api } = client({
      contractVersion: 3,
      operationId: id(3),
      status: 'CLOSED',
      cancelled: true,
      limitReleased: true,
      visitReturned: false,
    });
    await expect(
      api.cancel({ contractVersion: 3, operationId: id(3), reason: 'USER_CANCEL' }, envelope),
    ).resolves.toMatchObject({ status: 'CLOSED', limitReleased: true });

    expect(
      () =>
        new BookedOperationV3Client({
          baseUrl: 'http://lk1.example/',
          timeoutMs: 1_000,
        }),
    ).toThrow(BookedOperationV3ClientError);

    const { client: noToken } = client({});
    await expect(noToken.preflight(preflight, envelopeWithoutToken)).rejects.toBeInstanceOf(
      BookedOperationV3ClientError,
    );
  });
});
