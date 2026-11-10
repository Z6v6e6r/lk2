import { describe, expect, it, vi } from 'vitest';

import { Lk1ResultClient } from './lk1-result-client.js';

const HANDOFF = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  gameId: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  resultId: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
  resultRevision: 2,
  lk1GameId: '6641ab8f9c2e1d0001a2b3c4',
  submitterPhoneE164: '+79990001122',
  confirmedAt: '2026-11-09T09:05:00.000Z',
} as const;

const SCORE = { scoreA: 2, scoreB: 1 } as const;

function client(fetchImpl: typeof fetch) {
  return new Lk1ResultClient({
    baseUrl: 'https://padlhub.su/',
    serviceToken: 'x'.repeat(32),
    timeoutMs: 1_000,
    fetchImpl,
  });
}

describe('LK1 result client', () => {
  it('posts the confirmed result with the revision-bound idempotency key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));

    await expect(
      client(fetchImpl).importConfirmedResult({
        handoff: HANDOFF,
        score: SCORE,
        correlationId: 'correlation-0001',
      }),
    ).resolves.toBe('applied');

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://padlhub.su/lk-bridge/api/v1/game-results/import');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': `game-result:${HANDOFF.resultId}:v2`,
      'X-Correlation-ID': 'correlation-0001',
    });
    const body = init?.body;
    expect(typeof body === 'string' ? JSON.parse(body) : undefined).toEqual({
      gameId: HANDOFF.lk1GameId,
      externalResultId: HANDOFF.resultId,
      externalResultRevision: HANDOFF.resultRevision,
      submitterPhone: HANDOFF.submitterPhoneE164,
      scoreA: 2,
      scoreB: 1,
      confirmedAt: HANDOFF.confirmedAt,
    });
  });

  it('treats the LK1 replay answer as a delivered duplicate', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'LK1_RESULT_ALREADY_IMPORTED' }, { status: 409 }));

    await expect(
      client(fetchImpl).importConfirmedResult({
        handoff: HANDOFF,
        score: SCORE,
        correlationId: 'correlation-0002',
      }),
    ).resolves.toBe('duplicate');
  });

  it('reports a documented LK1 rejection instead of retrying forever', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'LK1_GAME_NOT_FOUND' }, { status: 422 }));

    await expect(
      client(fetchImpl).importConfirmedResult({
        handoff: HANDOFF,
        score: SCORE,
        correlationId: 'correlation-0003',
      }),
    ).resolves.toBe('rejected');
  });

  it('does not acknowledge an idempotency payload conflict', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'IDEMPOTENCY_KEY_REUSED' }, { status: 409 }));

    await expect(
      client(fetchImpl).importConfirmedResult({
        handoff: HANDOFF,
        score: SCORE,
        correlationId: 'correlation-0004',
      }),
    ).rejects.toThrow('LK1_RESULT_IDEMPOTENCY_CONFLICT');
  });

  it('fails the delivery on a transport-level error so the event is retried', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      client(fetchImpl).importConfirmedResult({
        handoff: HANDOFF,
        score: SCORE,
        correlationId: 'correlation-0005',
      }),
    ).rejects.toThrow('LK1_RESULT_HTTP_503');
  });
});
