import { describe, expect, it, vi } from 'vitest';

import { CupRatingClient } from './cup-rating-client.js';

const RESULT = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  gameId: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  resultId: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
  resultRevision: 2,
  kind: 'RATING' as const,
  title: 'Рейтинговая игра',
  startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:30:00.000Z',
  venueName: 'Селигерская',
  participantUserIds: [
    'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
    'a9c106f7-0db8-4e27-b1e0-298829f94730',
    '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
    'c68f263e-4a54-4472-9254-103e3b332538',
  ],
  sets: [
    {
      setNumber: 1,
      teamAUserIds: [
        'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
        'a9c106f7-0db8-4e27-b1e0-298829f94730',
      ] as [string, string],
      teamBUserIds: [
        '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
        'c68f263e-4a54-4472-9254-103e3b332538',
      ] as [string, string],
      teamA: 6,
      teamB: 4,
    },
  ],
};

describe('CUP rating client', () => {
  it('uses the confirmed result revision as the remote idempotency key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const client = new CupRatingClient({
      baseUrl: 'https://cup.internal/',
      serviceToken: 'x'.repeat(32),
      timeoutMs: 1_000,
      fetchImpl,
    });

    await expect(client.applyConfirmedResult(RESULT, 'correlation-0001')).resolves.toBe('applied');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://cup.internal/internal/api/v1/game-results/${RESULT.resultId}/apply-rating`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': `game-result:${RESULT.resultId}:v2`,
      'X-Correlation-ID': 'correlation-0001',
    });
  });

  it('treats CUP replay response as success', async () => {
    const client = new CupRatingClient({
      baseUrl: 'https://cup.internal',
      serviceToken: 'x'.repeat(32),
      timeoutMs: 1_000,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ code: 'CUP_RATING_ALREADY_APPLIED' }, { status: 409 })),
    });

    await expect(client.applyConfirmedResult(RESULT, 'correlation-0002')).resolves.toBe(
      'duplicate',
    );
  });

  it('does not acknowledge an idempotency payload conflict', async () => {
    const client = new CupRatingClient({
      baseUrl: 'https://cup.internal',
      serviceToken: 'x'.repeat(32),
      timeoutMs: 1_000,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ code: 'IDEMPOTENCY_KEY_REUSED' }, { status: 409 })),
    });

    await expect(client.applyConfirmedResult(RESULT, 'correlation-0003')).rejects.toThrow(
      'CUP_RATING_IDEMPOTENCY_CONFLICT',
    );
  });
});
