import { describe, expect, it, vi } from 'vitest';

import { createProfileFriendshipRepository } from './profile-friendship-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const targetUserId = '6a81e965-c508-4321-812c-4be323606a70';
const requestId = '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

/** Audit actions are bound parameters, so the assertion reads values instead of SQL text. */
function auditActions(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls
    .filter(([text]) => String(text).includes('audit.audit_log'))
    .map(([, values]) => String((values as readonly unknown[])[2]));
}

function baseQuery(handler: (text: string) => { rows: unknown[]; rowCount: number } | undefined) {
  return vi.fn((text: string) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const handled = handler(text);
    if (!handled) throw new Error(`Unexpected query: ${text}`);
    return Promise.resolve(handled);
  });
}

describe('profile friend request repository', () => {
  it('creates a pending request with audit and outbox rows in one transaction', async () => {
    const statements: string[] = [];
    const query = baseQuery((text) => {
      statements.push(text);
      if (text.includes('from profile.friend_request_commands')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('from identity.users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (text.includes('from profile.friendships')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.friend_requests')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into profile.friend_requests')) {
        return {
          rows: [{ id: requestId, created_at: '2026-08-29T10:00:00.000Z' }],
          rowCount: 1,
        };
      }
      if (text.includes('insert into')) return { rows: [], rowCount: 1 };
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.request({
        tenantId,
        actorUserId,
        targetUserId,
        idempotencyKey: 'friend-request-command-0001',
        requestHash: 'a'.repeat(64),
        correlationId: 'friend-request-correlation-0001',
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      friendship: {
        userId: targetUserId,
        status: 'PENDING_OUTGOING',
        createdAt: '2026-08-29T10:00:00.000Z',
        requestId,
      },
      replayed: false,
    });

    const insert = statements.find((text) => text.includes('insert into profile.friend_requests'));
    expect(insert).toContain('insert into profile.friend_requests');
    expect(insert).toContain('requester_user_id');
    expect(insert).not.toContain("'ACCEPTED'");
    expect(auditActions(query)).toContain('PROFILE_FRIEND_REQUEST_CREATED');
    expect(statements.some((text) => text.includes('profile.friend_request.created.v1'))).toBe(true);
    expect(
      statements.some((text) => text.includes('insert into profile.friend_request_commands')),
    ).toBe(true);
    // No friendship row is written before the target answers.
    expect(statements.some((text) => text.includes('insert into profile.friendships'))).toBe(false);
  });

  it('answers the reciprocal request immediately instead of leaving two pending rows', async () => {
    const statements: string[] = [];
    const query = baseQuery((text) => {
      statements.push(text);
      if (text.includes('from profile.friend_request_commands')) return { rows: [], rowCount: 0 };
      if (text.includes('from identity.users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (text.includes('from profile.friendships')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.friend_requests')) {
        return {
          rows: [{ id: requestId, created_at: '2026-08-28T10:00:00.000Z' }],
          rowCount: 1,
        };
      }
      if (text.includes('insert into profile.friendships')) {
        return { rows: [{ created_at: '2026-08-29T10:00:00.000Z' }], rowCount: 1 };
      }
      if (text.startsWith('update profile.friend_requests')) return { rows: [], rowCount: 1 };
      if (text.includes('insert into')) return { rows: [], rowCount: 1 };
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    const result = await repository.request({
      tenantId,
      actorUserId,
      targetUserId,
      idempotencyKey: 'friend-request-reciprocal-0001',
      requestHash: 'b'.repeat(64),
      correlationId: 'friend-request-reciprocal-correlation-0001',
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      friendship: { userId: targetUserId, status: 'FRIEND' },
    });
    expect(
      statements.some((text) => text.includes('PROFILE_FRIEND_REQUEST_ACCEPTED')),
    ).toBe(false);
    expect(auditActions(query)).toContain('PROFILE_FRIEND_REQUEST_ACCEPTED');
    expect(statements.some((text) => text.includes('profile.friendship.created.v1'))).toBe(true);
  });

  it('refuses to answer a request addressed to another player', async () => {
    const query = baseQuery((text) => {
      if (text.includes('from profile.friend_request_responses')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.friend_requests')) {
        return {
          rows: [
            {
              id: requestId,
              requester_user_id: actorUserId,
              target_user_id: targetUserId,
              state: 'PENDING',
            },
          ],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    // The actor is the requester, not the addressed player, so the command must not settle it.
    await expect(
      repository.respond({
        tenantId,
        actorUserId,
        requestId,
        action: 'ACCEPT',
        idempotencyKey: 'friend-request-response-0001',
        correlationId: 'friend-request-response-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('replays a stored response instead of answering twice', async () => {
    const stored = {
      userId: targetUserId,
      status: 'FRIEND',
      createdAt: '2026-08-29T10:00:00.000Z',
      requestId: null,
    };
    const query = baseQuery((text) => {
      if (text.includes('from profile.friend_request_responses')) {
        return {
          rows: [{ request_id: requestId, action: 'ACCEPT', result_payload: stored }],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.respond({
        tenantId,
        actorUserId,
        requestId,
        action: 'ACCEPT',
        idempotencyKey: 'friend-request-response-replay-0001',
        correlationId: 'friend-request-response-replay-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'applied', friendship: stored, replayed: true });
  });
});
