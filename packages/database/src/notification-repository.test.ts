import { describe, expect, it, vi } from 'vitest';

import { createNotificationInboxRepository } from './notification-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const itemId = '11111111-1111-4111-8111-111111111111';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('notification inbox repository', () => {
  it('keeps the tenant runtime disabled when no explicit settings exist', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from notifications.tenant_runtime_settings')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationInboxRepository(poolWithQuery(query) as never);

    await expect(repository.getRuntimeSettings(tenantId)).resolves.toEqual({
      inAppEnabled: false,
      webPushEnabled: false,
      iosPushEnabled: false,
      androidPushEnabled: false,
    });
  });

  it('returns an opaque-position-ready page and an independent unread count', async () => {
    const rows = [
      {
        id: itemId,
        category: 'GAME',
        title: 'Игра скоро начнётся',
        body: 'Начало в 19:00',
        deep_link: `/games/${itemId}`,
        created_at: new Date('2026-07-16T12:00:00.000Z'),
        read_at: null,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        category: 'GAME',
        title: 'Запасная запись',
        body: 'Для проверки пагинации',
        deep_link: null,
        created_at: new Date('2026-07-16T11:00:00.000Z'),
        read_at: null,
      },
    ];
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from notifications.inbox_items') && text.includes('order by')) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (text.includes('count(*)::integer')) {
        return Promise.resolve({ rows: [{ unread_count: 2 }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationInboxRepository(poolWithQuery(query) as never);

    await expect(
      repository.listInbox({ tenantId, userId, limit: 1, unreadOnly: false }),
    ).resolves.toMatchObject({
      items: [{ id: itemId, createdAt: '2026-07-16T12:00:00.000Z' }],
      unreadCount: 2,
      next: { id: itemId, createdAt: '2026-07-16T12:00:00.000Z' },
    });
  });

  it('advances the read cursor, audits the command and emits one identifier-only event', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from notifications.inbox_items') && text.includes('id = $3')) {
        return Promise.resolve({
          rows: [{ id: itemId, created_at: '2026-07-16 12:00:00.123456+00' }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into notifications.read_cursor_commands')) {
        return Promise.resolve({
          rows: [{ idempotency_key: 'read-command-test-0001' }],
          rowCount: 1,
        });
      }
      if (text.includes('from notifications.user_read_state')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('update notifications.inbox_items')) {
        return Promise.resolve({ rows: [], rowCount: 3 });
      }
      if (
        text.includes('insert into notifications.user_read_state') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('update notifications.read_cursor_commands') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationInboxRepository(poolWithQuery(query) as never);

    await expect(
      repository.markReadThrough({
        tenantId,
        userId,
        throughItemId: itemId,
        idempotencyKey: 'read-command-test-0001',
        correlationId: 'read-correlation-0001',
      }),
    ).resolves.toEqual({
      outcome: 'updated',
      readThrough: { id: itemId, createdAt: '2026-07-16T12:00:00.123456+00:00' },
      changedCount: 3,
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
  });
});
