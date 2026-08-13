import { realtimeTicketRedisKey } from '@phub/auth';
import { decodeJwt } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { RedisRealtimeTicketIssuer } from './realtime-ticket-issuer.js';

describe('Redis realtime ticket issuer', () => {
  it('stores only the session-bound one-time marker for 30 seconds', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(1);
    const issuer = new RedisRealtimeTicketIssuer(
      { set, del },
      {
        JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
        JWT_ISSUER: 'phub-identity',
        JWT_REALTIME_AUDIENCE: 'phub-realtime',
      },
    );
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const result = await issuer.issue({
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      tenantKey: 'local-padel',
      userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
      sessionId,
    });
    const claims = decodeJwt(result.ticket);

    expect(claims).toMatchObject({
      scope: 'realtime.connect',
      tenantKey: 'local-padel',
      sid: sessionId,
    });
    expect(result.ticketId).toBe(claims.jti);
    expect(set).toHaveBeenCalledWith(
      realtimeTicketRedisKey(result.ticketId),
      sessionId,
      'EX',
      30,
      'NX',
    );
    expect(JSON.stringify(set.mock.calls)).not.toContain(result.ticket);
    await issuer.revoke(result.ticketId);
    expect(del).toHaveBeenCalledWith(realtimeTicketRedisKey(result.ticketId));
  });
});
