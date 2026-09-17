import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createProfileFriendshipRepository } from './profile-friendship-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const targetUserId = '6a81e965-c508-4321-812c-4be323606a70';
const createdAt = '2026-09-17T10:00:00.123Z';
const input = {
  tenantId,
  actorUserId,
  targetUserId,
  expectedCreatedAt: createdAt,
  requestHash: createHash('sha256').update(`REMOVE:${targetUserId}:${createdAt}`).digest('hex'),
  idempotencyKey: 'remove-friend-test-0001',
  correlationId: 'remove-friend-correlation',
};
const removed = { userId: targetUserId, status: 'NONE', createdAt: null, requestId: null };

function fixture(
  options: { previous?: unknown; createdAt?: string | null; failOutbox?: boolean } = {},
) {
  const query = vi.fn<(sql: string, values?: unknown[]) => { rows: unknown[] }>((sql) => {
    if (sql.includes('from profile.friendship_commands'))
      return { rows: options.previous ? [options.previous] : [] };
    if (sql.includes('select created_at from profile.friendships'))
      return {
        rows: options.createdAt === null ? [] : [{ created_at: options.createdAt ?? createdAt }],
      };
    if (sql.includes('update profile.friend_requests'))
      return { rows: [{ id: 'old-accepted-request' }] };
    if (sql.includes('insert into audit.outbox_events') && options.failOutbox)
      throw new Error('outbox unavailable');
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    query,
    connect,
    release,
    repository: createProfileFriendshipRepository({ connect } as never),
  };
}

describe('friendship removal', () => {
  it.each([
    [actorUserId, targetUserId],
    [targetUserId, actorUserId],
  ])('removes only its authenticated symmetric pair (%s)', async (actor, target) => {
    const { repository, query, release } = fixture();
    expect(await repository.remove({ ...input, actorUserId: actor, targetUserId: target })).toEqual(
      { outcome: 'applied', friendship: { ...removed, userId: target }, replayed: false },
    );
    const calls = query.mock.calls;
    expect(calls.find(([sql]) => sql.includes('delete from profile.friendships'))?.[1]).toEqual([
      tenantId,
      actorUserId,
      targetUserId,
    ]);
    const deleteIndex = calls.findIndex(([sql]) => sql.includes('delete from profile.friendships'));
    const pairLockIndex = calls.findIndex(
      ([sql, values]) =>
        sql.includes('pg_advisory_xact_lock') &&
        values?.[0] === `${tenantId}:${actorUserId}:${targetUserId}`,
    );
    expect(pairLockIndex).toBeGreaterThan(0);
    expect(pairLockIndex).toBeLessThan(deleteIndex);
    const retired = calls.find(([sql]) => sql.includes('update profile.friend_requests'));
    expect(retired?.[0]).toContain("state = 'ACCEPTED'");
    expect(retired?.[1]).toEqual([tenantId, actorUserId, targetUserId]);
    const audit = calls.find(([sql]) => sql.includes('insert into audit.audit_log'));
    expect(audit?.[0]).toContain('PROFILE_FRIENDSHIP_REMOVED');
    expect(JSON.parse(String(audit?.[1]?.[4]))).toMatchObject({
      retiredAcceptedRequestIds: ['old-accepted-request'],
      removedCreatedAt: createdAt,
    });
    expect(calls.some(([sql]) => sql.includes('profile.friendship.removed.v1'))).toBe(true);
    expect(calls.at(-1)?.[0]).toBe('commit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('replays the durable receipt before examining a later friendship', async () => {
    const { repository, query } = fixture({
      previous: {
        target_user_id: targetUserId,
        request_hash: createHash('sha256')
          .update(`REMOVE:${targetUserId}:${createdAt}`)
          .digest('hex'),
        result_payload: removed,
      },
      createdAt: '2026-09-18T10:00:00.000Z',
    });
    expect(await repository.remove(input)).toEqual({
      outcome: 'applied',
      friendship: removed,
      replayed: true,
    });
    expect(query.mock.calls.some(([sql]) => /^\s*(delete|update|insert)\b/i.test(sql))).toBe(false);
  });

  it.each(['different-target', 'different-hash'])(
    'rejects key reuse for %s without mutation',
    async (difference) => {
      const { repository, query } = fixture({
        previous: {
          target_user_id: difference === 'different-target' ? actorUserId : targetUserId,
          request_hash:
            difference === 'different-hash'
              ? 'wrong'
              : createHash('sha256').update(`REMOVE:${targetUserId}:${createdAt}`).digest('hex'),
          result_payload: removed,
        },
      });
      expect(await repository.remove(input)).toEqual({ outcome: 'idempotency_conflict' });
      expect(query.mock.calls.some(([sql]) => /^\s*(delete|update|insert)\b/i.test(sql))).toBe(
        false,
      );
    },
  );

  it.each([
    [null, 'not_found'],
    ['2026-09-18T10:00:00.000Z', 'friendship_changed'],
  ] as const)('does not remove absent or replaced friendships (%s)', async (value, outcome) => {
    const { repository, query } = fixture({ createdAt: value });
    expect(await repository.remove(input)).toEqual({ outcome });
    expect(query.mock.calls.some(([sql]) => /^\s*(delete|update|insert)\b/i.test(sql))).toBe(false);
  });

  it('rejects a self target before opening a transaction', async () => {
    const { repository, connect } = fixture();
    expect(await repository.remove({ ...input, targetUserId: actorUserId })).toEqual({
      outcome: 'not_found',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rolls back deletion and receipt if the outbox write fails', async () => {
    const { repository, query, release } = fixture({ failOutbox: true });
    await expect(repository.remove(input)).rejects.toThrow('outbox unavailable');
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
