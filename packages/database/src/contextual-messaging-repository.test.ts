import { describe, expect, it, vi } from 'vitest';

import { createContextualMessagingRepository } from './contextual-messaging-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const eventId = '11111111-1111-4111-8111-111111111111';
const gameId = '22222222-2222-4222-8222-222222222222';
const organizerId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('contextual messaging repository', () => {
  it('projects a canonical game and publishes identifiers without its title', async () => {
    const title = 'Закрытая тестовая игра';
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.context_projection_events')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from games.games')) {
        return Promise.resolve({
          rows: [
            {
              id: gameId,
              organizer_user_id: organizerId,
              title,
              lifecycle_state: 'SCHEDULED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from messaging.conversations')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into messaging.conversations')) {
        return Promise.resolve({ rows: [{ id: conversationId }], rowCount: 1 });
      }
      if (
        text.includes('messaging.conversation_members') ||
        text.includes('messaging.context_projection_events') ||
        text.includes('audit.outbox_events') ||
        text.includes('audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createContextualMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.projectGameConversation({
        tenantId,
        eventId,
        gameId,
        correlationId: 'game-conversation-correlation',
      }),
    ).resolves.toBe('projected');

    const outboxCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(outboxCall).toBeDefined();
    expect(JSON.stringify(outboxCall?.[1])).not.toContain(title);
    expect(JSON.stringify(outboxCall?.[1])).toContain(conversationId);
    expect(JSON.stringify(outboxCall?.[1])).toContain(gameId);
  });

  it('acknowledges a replay before reading the owning aggregate', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.context_projection_events')) {
        return Promise.resolve({ rows: [{ conversation_id: conversationId }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createContextualMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.projectGameConversation({
        tenantId,
        eventId,
        gameId,
        correlationId: 'game-conversation-correlation',
      }),
    ).resolves.toBe('replayed');
    expect(query.mock.calls.some(([text]) => String(text).includes('from games.games'))).toBe(
      false,
    );
  });

  it('closes an existing conversation and removes active members after cancellation', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.context_projection_events')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from games.games')) {
        return Promise.resolve({
          rows: [
            {
              id: gameId,
              organizer_user_id: organizerId,
              title: 'Отменённая игра',
              lifecycle_state: 'CANCELLED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from messaging.conversations')) {
        return Promise.resolve({ rows: [{ id: conversationId }], rowCount: 1 });
      }
      if (text.includes('update messaging.conversations')) {
        expect(values).toEqual([tenantId, conversationId, 'Отменённая игра', 'CANCELLED']);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('update messaging.conversation_members') ||
        text.includes('insert into messaging.context_projection_events') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createContextualMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.projectGameConversation({
        tenantId,
        eventId,
        gameId,
        correlationId: 'cancelled-game-correlation',
      }),
    ).resolves.toBe('projected');
    expect(
      query.mock.calls.some(
        ([text]) =>
          String(text).includes('update messaging.conversation_members') &&
          String(text).includes("state = 'REMOVED'"),
      ),
    ).toBe(true);
  });
});
