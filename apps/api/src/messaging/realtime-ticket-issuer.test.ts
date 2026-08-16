import { realtimeTicketRedisKey } from '@phub/auth';
import { decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { RedisRealtimeTicketIssuer } from './realtime-ticket-issuer.js';

describe('Redis realtime ticket issuer', () => {
  it('stores only the session-bound one-time marker for 30 seconds', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(1);
    const issuer = new RedisRealtimeTicketIssuer(
      { set, del },
      {
        JWT_REALTIME_SECRET: 'test-realtime-secret-at-least-32-characters',
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
    await expect(
      jwtVerify(
        result.ticket,
        new TextEncoder().encode('test-realtime-secret-at-least-32-characters'),
        { issuer: 'phub-identity', audience: 'phub-realtime' },
      ),
    ).resolves.toMatchObject({ payload: { sub: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca' } });
    await expect(
      jwtVerify(
        result.ticket,
        new TextEncoder().encode('test-access-secret-at-least-32-characters'),
      ),
    ).rejects.toThrow();

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

  it('fails closed before reserving a ticket when the dedicated key is absent', async () => {
    const set = vi.fn();
    const issuer = new RedisRealtimeTicketIssuer(
      { set, del: vi.fn() },
      {
        JWT_REALTIME_SECRET: undefined,
        JWT_ISSUER: 'phub-identity',
        JWT_REALTIME_AUDIENCE: 'phub-realtime',
      },
    );

    await expect(
      issuer.issue({
        tenantId: '86afbe01-0318-4dd2-b276-db094fc4b12e',
        tenantKey: 'local-padel',
        userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
        sessionId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrow('REALTIME_TICKET_SIGNING_KEY_UNAVAILABLE');
    expect(set).not.toHaveBeenCalled();
  });
});
