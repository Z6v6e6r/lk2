import { describe, expect, it, vi } from 'vitest';

import { createMessagingRepository } from './messaging-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '44444444-4444-4444-8444-444444444444';
const conversationId = '11111111-1111-4111-8111-111111111111';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function input(
  sourceEventType:
    | 'game.scheduled.v1'
    | 'game.participation.confirmed.v1'
    | 'game.participation.left.v1'
    | 'game.cancelled.v1',
) {
  return {
    tenantId,
    gameId,
    sourceEventId: '51111111-1111-4111-8111-111111111111',
    sourceEventType,
    sourceAggregateRevision: '3',
    correlationId: 'game-membership-test-correlation',
    occurredAt: '2026-09-04T10:00:00.000Z',
  } as const;
}

function harness(
  options: {
    readonly conversation?: boolean;
    readonly conversationState?: 'OPEN' | 'CLOSED' | 'ARCHIVED';
    readonly game?: boolean;
    readonly gameRevision?: string;
    readonly lifecycle?: string;
    readonly activated?: readonly string[];
    readonly left?: readonly string[];
    readonly closed?: boolean;
  } = {},
) {
  let projectionPass = 0;
  const query = vi.fn((text: string) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('select id, state') && text.includes('messaging.conversations')) {
      return Promise.resolve(
        options.conversation === false
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{ id: conversationId, state: options.conversationState ?? 'OPEN' }],
              rowCount: 1,
            },
      );
    }
    if (text.includes('revision::text as revision')) {
      return Promise.resolve(
        options.game === false
          ? { rows: [], rowCount: 0 }
          : {
              rows: [
                {
                  revision: options.gameRevision ?? '3',
                  lifecycle_state: options.lifecycle ?? 'SCHEDULED',
                },
              ],
              rowCount: 1,
            },
      );
    }
    if (text.includes('select user_id, role') && text.includes('games.participations')) {
      return Promise.resolve({ rows: [{ user_id: userId, role: 'PLAYER' }], rowCount: 1 });
    }
    if (text.includes('update messaging.conversations')) {
      return Promise.resolve(
        options.closed === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: conversationId }], rowCount: 1 },
      );
    }
    if (text.includes('insert into messaging.conversation_members')) {
      projectionPass += 1;
      const rows =
        projectionPass === 1 ? (options.activated ?? []).map((user_id) => ({ user_id })) : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (text.includes('update messaging.conversation_members')) {
      const rows = projectionPass <= 1 ? (options.left ?? []).map((user_id) => ({ user_id })) : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (text.includes('insert into audit.audit_log')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
  return { repository: createMessagingRepository(pool as never), query };
}

describe('GAME messaging membership snapshot reconciliation', () => {
  it('activates a missing or LEFT current participant in an existing OPEN conversation', async () => {
    const { repository } = harness({ activated: [userId] });
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
    ).resolves.toEqual({
      outcome: 'applied',
      conversationClosed: false,
      activatedUserIds: [userId],
      leftUserIds: [],
    });
  });

  it('marks a departed member LEFT while keeping the conversation OPEN', async () => {
    const { repository, query } = harness({ left: [userId] });
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.left.v1')),
    ).resolves.toMatchObject({ outcome: 'applied', leftUserIds: [userId] });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("state = 'CLOSED'"))).toBe(false);
  });

  it('keeps a rejoined participant ACTIVE when a stale leave event arrives', async () => {
    const { repository, query } = harness();
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.left.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("participation.state = 'ACTIVE'")),
    ).toBe(true);
  });

  it('closes a cancelled game conversation and marks every active USER member LEFT', async () => {
    const { repository } = harness({ lifecycle: 'CANCELLED', left: [userId] });
    await expect(
      repository.reconcileGameConversationMembership(input('game.cancelled.v1')),
    ).resolves.toEqual({
      outcome: 'applied',
      conversationClosed: true,
      activatedUserIds: [],
      leftUserIds: [userId],
    });
  });

  it('makes a duplicate confirmed delivery a no-op with no second audit', async () => {
    const { repository, query } = harness({ activated: [userId] });
    await repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1'));
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('audit.audit_log')),
    ).toHaveLength(1);
  });

  it('makes a duplicate left delivery a no-op with no duplicate audit', async () => {
    const { repository, query } = harness({ left: [userId] });
    await repository.reconcileGameConversationMembership(input('game.participation.left.v1'));
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.left.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('audit.audit_log')),
    ).toHaveLength(1);
  });

  it('makes a duplicate cancel delivery a no-op with no duplicate audit', async () => {
    const { repository, query } = harness({ lifecycle: 'CANCELLED', left: [userId] });
    await repository.reconcileGameConversationMembership(input('game.cancelled.v1'));
    const second = harness({
      lifecycle: 'CANCELLED',
      conversationState: 'CLOSED',
      closed: false,
    });
    await expect(
      second.repository.reconcileGameConversationMembership(input('game.cancelled.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('audit.audit_log')),
    ).toHaveLength(1);
    expect(
      second.query.mock.calls.filter(([sql]) => String(sql).includes('audit.audit_log')),
    ).toHaveLength(0);
  });

  it('does not create a missing conversation', async () => {
    const { repository, query } = harness({ conversation: false });
    await expect(
      repository.reconcileGameConversationMembership(input('game.scheduled.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('insert into messaging.conversations')),
    ).toBe(false);
  });

  it('does not cross a tenant boundary when no tenant-local conversation is visible', async () => {
    const { repository, query } = harness({ conversation: false });
    await repository.reconcileGameConversationMembership(input('game.participation.left.v1'));
    expect(query.mock.calls.some(([sql]) => String(sql).includes('games.games'))).toBe(false);
  });

  it('fails closed when the event revision is ahead of the GAME snapshot', async () => {
    const { repository, query } = harness({ gameRevision: '2' });
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
    ).resolves.toEqual({ outcome: 'revision_conflict' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('conversation_members'))).toBe(
      false,
    );
  });

  it('does not reactivate a member for an old confirmed event after current leave', async () => {
    const { repository } = harness({ left: [userId], gameRevision: '5' });
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
    ).resolves.toMatchObject({ outcome: 'applied', activatedUserIds: [], leftUserIds: [userId] });
  });

  it('does not reopen or reactivate after cancellation even for a confirmed event', async () => {
    const { repository } = harness({
      lifecycle: 'CANCELLED',
      conversationState: 'CLOSED',
      closed: false,
    });
    await expect(
      repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
    ).resolves.toEqual({ outcome: 'no_op' });
  });

  it.each(['CLOSED', 'ARCHIVED'] as const)(
    'never reopens an existing %s conversation',
    async (state) => {
      const { repository, query } = harness({ conversationState: state, activated: [userId] });
      await expect(
        repository.reconcileGameConversationMembership(input('game.participation.confirmed.v1')),
      ).resolves.toEqual({ outcome: 'no_op' });
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).includes('insert into messaging.conversation_members'),
        ),
      ).toBe(false);
    },
  );

  it('never writes the authoritative GAME tables', async () => {
    const { repository, query } = harness({ activated: [userId] });
    await repository.reconcileGameConversationMembership(input('game.scheduled.v1'));
    expect(
      query.mock.calls.some(([sql]) =>
        /(?:insert|update|delete)\s+(?:into\s+|from\s+)?games\./i.test(String(sql)),
      ),
    ).toBe(false);
  });
});
