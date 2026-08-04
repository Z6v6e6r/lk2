import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { createRealtimeAuthorizationRepository } from './realtime-authorization-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '55555555-5555-4555-8555-555555555555';
const communityId = '11111111-1111-4111-8111-111111111111';

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: (handler(text, values) as readonly unknown[]) ?? [] });
  });
  const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
  return { pool: pool as unknown as Pool, connect: pool.connect, query };
}

describe('realtime authorization repository', () => {
  it('binds a connection to an active refresh-session family and active user', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from identity.refresh_sessions presented')) {
        expect(values).toEqual([tenantId, sessionId, userId]);
        return [{ authorized: true }];
      }
      return [];
    });
    const repository = createRealtimeAuthorizationRepository(pool);

    await expect(repository.authorizeConnection({ tenantId, userId, sessionId })).resolves.toEqual({
      outcome: 'ok',
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('active_session.family_id')),
    ).toBe(true);
    expect(query.mock.calls.map(([text]) => String(text)).join('\n')).not.toContain(
      ' current_user',
    );
  });

  it('fails a community subscription closed unless membership and aggregate are active', async () => {
    const active = poolWithQuery((text, values) => {
      if (text.includes('from communities.communities community')) {
        expect(values).toEqual([tenantId, userId, communityId]);
        return [{ community_revision: 7, membership_revision: 4, latest_sequence: 12 }];
      }
      return [];
    });
    await expect(
      createRealtimeAuthorizationRepository(active.pool).authorizeCommunitySubscription({
        tenantId,
        userId,
        communityId,
        enabled: true,
      }),
    ).resolves.toEqual({
      outcome: 'ok',
      communityRevision: 7,
      membershipRevision: 4,
      latestSequence: 12,
    });

    const disabled = poolWithQuery(() => []);
    await expect(
      createRealtimeAuthorizationRepository(disabled.pool).authorizeCommunitySubscription({
        tenantId,
        userId,
        communityId,
        enabled: false,
      }),
    ).resolves.toEqual({ outcome: 'disabled' });
    expect(disabled.connect).not.toHaveBeenCalled();
  });

  it('batch-authorizes current memberships and live session families for fan-out', async () => {
    const secondUserId = '33333333-3333-4333-8333-333333333333';
    const secondSessionId = '44444444-4444-4444-8444-444444444444';
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('with requested as')) {
        expect(values).toEqual([
          tenantId,
          communityId,
          [userId, secondUserId],
          [sessionId, secondSessionId],
        ]);
        return [{ session_id: sessionId }];
      }
      return [];
    });
    await expect(
      createRealtimeAuthorizationRepository(pool).authorizeCommunityFanoutRecipients({
        tenantId,
        communityId,
        recipients: [
          { userId, sessionId },
          { userId: secondUserId, sessionId: secondSessionId },
        ],
      }),
    ).resolves.toEqual(new Set([sessionId]));
    const authorization = query.mock.calls.find(([text]) =>
      String(text).includes('with requested as'),
    );
    expect(authorization?.[0]).toContain("membership.status = 'ACTIVE'");
    expect(authorization?.[0]).toContain('active_session.family_id');
  });

  it('records ticket metadata without storing the ticket or session secret', async () => {
    const { pool, query } = poolWithQuery(() => []);
    await createRealtimeAuthorizationRepository(pool).recordTicketIssued({
      tenantId,
      userId,
      ticketId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2026-08-04T12:00:30.000Z',
      correlationId: 'realtime-ticket-correlation',
    });
    const audit = query.mock.calls.find(([text]) =>
      String(text).includes("'REALTIME_TICKET_ISSUED'"),
    );
    expect(audit?.[1]).toEqual([
      tenantId,
      userId,
      '33333333-3333-4333-8333-333333333333',
      'realtime-ticket-correlation',
      JSON.stringify({ expiresAt: '2026-08-04T12:00:30.000Z' }),
    ]);
  });
});
