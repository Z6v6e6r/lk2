import { describe, expect, it, vi } from 'vitest';

import { LegacyPromotionEngagementSink } from './legacy-promotion-engagement-sink.js';

describe('legacy promotion engagement sink', () => {
  it('uses the private key and retries one transient server failure', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const sink = new LegacyPromotionEngagementSink({
      baseUrl: 'https://cup.padlhub.test',
      secret: 'promotion-engagement-secret-for-tests',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation,
    });

    await sink.record({
      eventId: 'promotion-click-0001',
      placement: 'cabinet_for_me_card',
      adId: 'cup-ad-1',
      kind: 'CLICK',
      phoneE164: '+79990000001',
      occurredAt: '2026-08-01T12:00:00.000Z',
      correlationId: 'promotion-correlation-0001',
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImplementation.mock.calls[1] ?? [];
    expect(url).toEqual(new URL('https://cup.padlhub.test/api/advertising/engagements'));
    expect(new Headers(init?.headers).get('X-Advertising-Event-Key')).toBe(
      'promotion-engagement-secret-for-tests',
    );
    const body = init?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(body)).toMatchObject({
      eventId: 'promotion-click-0001',
      kind: 'CLICK',
      phoneE164: '+79990000001',
    });
  });
});
