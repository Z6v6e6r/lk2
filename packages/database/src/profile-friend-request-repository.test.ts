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
    expect(statements.some((text) => text.includes('profile.friend_request.created.v1'))).toBe(
      true,
    );
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
    expect(statements.some((text) => text.includes('PROFILE_FRIEND_REQUEST_ACCEPTED'))).toBe(false);
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

  it('locks the pair before re-reading a settled request and never recreates a removed friendship', async () => {
    const query = baseQuery((text) => {
      if (text.includes('from profile.friend_request_responses')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.friend_requests'))
        return {
          rows: [
            {
              id: requestId,
              requester_user_id: actorUserId,
              target_user_id: targetUserId,
              state: 'DECLINED',
            },
          ],
          rowCount: 1,
        };
      if (text.includes('from profile.friendships')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into profile.friend_request_responses'))
        return { rows: [], rowCount: 1 };
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);
    expect(
      await repository.respond({
        tenantId,
        actorUserId: targetUserId,
        requestId,
        action: 'ACCEPT',
        idempotencyKey: 'friend-response-after-removal',
        correlationId: 'friend-response-correlation',
      }),
    ).toMatchObject({
      outcome: 'applied',
      friendship: { userId: actorUserId, status: 'NONE' },
      replayed: false,
    });
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    const preRead = calls.findIndex(([sql]) =>
      sql.includes('select requester_user_id, target_user_id'),
    );
    const lock = calls.findIndex(
      ([sql, values]) =>
        sql.includes('pg_advisory_xact_lock') &&
        values?.[0] === `${tenantId}:${actorUserId}:${targetUserId}`,
    );
    const rowLock = calls.findIndex(
      ([sql]) => sql.includes('from profile.friend_requests') && sql.includes('for update'),
    );
    expect(preRead).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(preRead);
    expect(rowLock).toBeGreaterThan(lock);
    expect(calls.some(([sql]) => sql.includes('insert into profile.friendships'))).toBe(false);
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

  it('refuses an active target that has no login path at all', async () => {
    const statements: string[] = [];
    const query = baseQuery((text) => {
      statements.push(text);
      if (text.includes('from profile.friend_request_commands')) return { rows: [], rowCount: 0 };
      // The reachability-guarded lookup finds nothing, while the plain active-user lookup does:
      // the row is an imported legacy player that can never sign in.
      if (text.includes('reachable_summary')) return { rows: [], rowCount: 0 };
      if (text.includes('from identity.users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      // No unambiguous imported player association, so the request cannot be kept either.
      if (text.includes('from integration.external_entity_map')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.request({
        tenantId,
        actorUserId,
        targetUserId,
        idempotencyKey: 'friend-request-unreachable-0001',
        requestHash: 'c'.repeat(64),
        correlationId: 'friend-request-unreachable-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'target_unreachable' });

    expect(statements.some((text) => text.includes('insert into profile.friend_requests'))).toBe(
      false,
    );
    expect(
      statements.some((text) => text.includes('insert into profile.deferred_friend_requests')),
    ).toBe(false);
  });

  it('keeps a deferred request for an imported player whose association is known', async () => {
    const deferredId = '7c1f0f52-7f0e-4a3f-9f39-2f7a1f2f6c11';
    const associationId = 'b'.repeat(64);
    const statements: string[] = [];
    const query = baseQuery((text) => {
      statements.push(text);
      if (text.includes('from profile.friend_request_commands')) return { rows: [], rowCount: 0 };
      if (text.includes('reachable_summary')) return { rows: [], rowCount: 0 };
      if (text.includes('from identity.users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (text.includes('from integration.external_entity_map')) {
        return { rows: [{ external_id: associationId }], rowCount: 1 };
      }
      if (text.includes('from profile.deferred_friend_requests')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into profile.deferred_friend_requests')) {
        return {
          rows: [{ id: deferredId, created_at: '2026-09-18T09:00:00.000Z' }],
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
        idempotencyKey: 'friend-request-deferred-0001',
        requestHash: 'd'.repeat(64),
        correlationId: 'friend-request-deferred-correlation-0001',
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      friendship: {
        userId: targetUserId,
        status: 'PENDING_DEFERRED',
        createdAt: '2026-09-18T09:00:00.000Z',
        requestId: null,
      },
      replayed: false,
    });

    expect(
      statements.some((text) => text.includes('insert into profile.deferred_friend_requests')),
    ).toBe(true);
    expect(statements.some((text) => text.includes('insert into profile.friend_requests'))).toBe(
      false,
    );
    // A deferred request is not a real request yet, so it must not announce one.
    expect(statements.some((text) => text.includes('profile.friend_request.created.v1'))).toBe(
      false,
    );
    const audit = statements.find((text) => text.includes('audit.audit_log'));
    expect(audit).toBeDefined();
  });

  it('replays a stored deferred request for the same command key', async () => {
    const stored = {
      userId: targetUserId,
      status: 'PENDING_DEFERRED',
      createdAt: '2026-09-18T09:00:00.000Z',
      requestId: null,
    };
    const statements: string[] = [];
    const query = baseQuery((text) => {
      statements.push(text);
      if (text.includes('from profile.friend_request_commands')) {
        return {
          rows: [
            {
              target_user_id: targetUserId,
              request_hash: 'e'.repeat(64),
              result_payload: stored,
            },
          ],
          rowCount: 1,
        };
      }
      return undefined;
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.request({
        tenantId,
        actorUserId,
        targetUserId,
        idempotencyKey: 'friend-request-deferred-replay-0001',
        requestHash: 'e'.repeat(64),
        correlationId: 'friend-request-deferred-replay-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'applied', friendship: stored, replayed: true });
    expect(statements.some((text) => text.includes('from integration.external_entity_map'))).toBe(
      false,
    );
  });

  it('delivers a deferred request once the imported association is bound to a live account', async () => {
    const deferredId = '7c1f0f52-7f0e-4a3f-9f39-2f7a1f2f6c11';
    const deliveredRequestId = '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91';
    const statements: string[] = [];
    const settlements: unknown[][] = [];
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      statements.push(text);
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('join integration.legacy_game_player_bindings')) {
        return Promise.resolve({
          rows: [
            {
              id: deferredId,
              requester_user_id: actorUserId,
              live_user_id: targetUserId,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes("set state = 'DELIVERED'")) {
        settlements.push(values ? [...values] : []);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('from profile.friend_request_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('reachable_summary')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      if (text.includes('from profile.friendships')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into profile.friend_requests')) {
        return Promise.resolve({
          rows: [{ id: deliveredRequestId, created_at: '2026-09-18T10:00:00.000Z' }],
          rowCount: 1,
        });
      }
      if (text.includes('from profile.friend_requests')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into')) return Promise.resolve({ rows: [], rowCount: 1 });
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.deliverDeferredFriendRequests({
        tenantId,
        limit: 10,
        correlationId: 'deferred-delivery-correlation-0001',
      }),
    ).resolves.toEqual({ delivered: 1, pending: 0 });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toEqual([tenantId, deferredId, 'REQUEST_CREATED', deliveredRequestId]);
    expect(
      statements.some(
        (text) =>
          text.includes('insert into profile.friend_requests') &&
          text.includes('values ($1, $2, $3)'),
      ),
    ).toBe(true);
  });

  it('leaves a deferred request pending while the live account is still unreachable', async () => {
    const deferredId = '7c1f0f52-7f0e-4a3f-9f39-2f7a1f2f6c11';
    const statements: string[] = [];
    const query = vi.fn((text: string) => {
      statements.push(text);
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('join integration.legacy_game_player_bindings')) {
        return Promise.resolve({
          rows: [
            {
              id: deferredId,
              requester_user_id: actorUserId,
              live_user_id: targetUserId,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from profile.friend_request_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('reachable_summary')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from identity.users')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      // The live account exists but still has no login path, and the live id carries no imported
      // association of its own, so the row must stay pending instead of settling.
      if (text.includes('from integration.external_entity_map')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(
      repository.deliverDeferredFriendRequests({
        tenantId,
        limit: 10,
        correlationId: 'deferred-delivery-correlation-0002',
      }),
    ).resolves.toEqual({ delivered: 0, pending: 1 });
    expect(statements.some((text) => text.includes("set state = 'DELIVERED'"))).toBe(false);
  });

  it('lists pending outgoing requests by requester and names the addressed peer', async () => {
    let sql = '';
    let params: readonly unknown[] | undefined;
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from profile.friend_requests request')) {
        sql = text;
        params = values;
        return Promise.resolve({
          rows: [
            {
              id: requestId,
              peer_user_id: targetUserId,
              display_name: 'Пётр Волков',
              level_label: 'B',
              delivery_id: null,
              created_at: '2026-08-30T09:00:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(repository.listOutgoing(tenantId, actorUserId, 8)).resolves.toEqual({
      items: [
        {
          requestId,
          userId: targetUserId,
          displayName: 'Пётр Волков',
          avatarUrl: null,
          levelLabel: 'B',
          createdAt: '2026-08-30T09:00:00.000Z',
          route: `/profile/${targetUserId}`,
        },
      ],
    });
    expect(sql).toContain('request.requester_user_id = $2');
    expect(sql).toContain("request.state = 'PENDING'");
    expect(sql).not.toContain('request.target_user_id = $2');
    expect(params).toEqual([tenantId, actorUserId, 8]);
  });

  it('keeps the incoming list scoped to the addressee', async () => {
    let sql = '';
    let params: readonly unknown[] | undefined;
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from profile.friend_requests request')) {
        sql = text;
        params = values;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileFriendshipRepository(poolWithQuery(query) as never);

    await expect(repository.listIncoming(tenantId, actorUserId, 4)).resolves.toEqual({
      items: [],
    });
    expect(sql).toContain('request.target_user_id = $2');
    expect(sql).not.toContain('request.requester_user_id = $2');
    expect(params).toEqual([tenantId, actorUserId, 4]);
  });
});
