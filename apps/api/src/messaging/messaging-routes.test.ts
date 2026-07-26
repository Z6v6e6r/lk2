import { loadConfig } from '@phub/config';
import type { MessagingRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(
  permissions: readonly string[] = ['chat.direct.create'],
): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository(overrides: Partial<MessagingRepository> = {}): MessagingRepository {
  return {
    getRuntimeSettings: vi.fn().mockResolvedValue({
      httpEnabled: true,
      directEnabled: true,
      realtimeEnabled: false,
      contextualEnabled: false,
    }),
    listConversations: vi.fn().mockResolvedValue([
      {
        id: conversationId,
        kind: 'DIRECT',
        participant: { userId: otherUserId, displayName: 'Борис' },
        unreadCount: 1,
        updatedAt: '2026-07-26T12:00:00.000Z',
      },
    ]),
    createDirectConversation: vi.fn().mockResolvedValue({
      outcome: 'ok',
      conversation: {
        id: conversationId,
        kind: 'DIRECT',
        participant: { userId: otherUserId, displayName: 'Борис' },
        unreadCount: 0,
        updatedAt: '2026-07-26T12:00:00.000Z',
      },
      created: true,
      replayed: false,
    }),
    listMessages: vi.fn().mockResolvedValue({
      outcome: 'ok',
      page: {
        messages: [
          {
            id: messageId,
            conversationId,
            sequence: 1,
            sender: { userId, displayName: 'Анна' },
            messageType: 'TEXT',
            body: 'Привет',
            createdAt: '2026-07-26T12:00:00.000Z',
          },
        ],
      },
    }),
    sendMessage: vi.fn().mockResolvedValue({
      outcome: 'ok',
      message: {
        id: messageId,
        conversationId,
        sequence: 1,
        sender: { userId, displayName: 'Анна' },
        messageType: 'TEXT',
        body: 'Привет',
        createdAt: '2026-07-26T12:00:00.000Z',
      },
      replayed: false,
    }),
    markRead: vi.fn().mockResolvedValue({
      outcome: 'ok',
      readThroughSequence: 1,
      changed: true,
      replayed: false,
    }),
    authorizeRealtimeSubscription: vi.fn().mockResolvedValue({
      outcome: 'ok',
      latestSequence: 1,
    }),
    listRealtimeRecipientUserIds: vi.fn().mockResolvedValue([userId, otherUserId]),
    recordRealtimeTicketIssued: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('messaging User API', () => {
  it('keeps the entire surface closed until the tenant HTTP gate is enabled', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        getRuntimeSettings: vi.fn().mockResolvedValue({
          httpEnabled: false,
          directEnabled: false,
          realtimeEnabled: false,
          contextualEnabled: false,
        }),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/conversations',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_DISABLED' });
  });

  it('keeps direct messaging closed when only the tenant HTTP gate is enabled', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        getRuntimeSettings: vi.fn().mockResolvedValue({
          httpEnabled: true,
          directEnabled: false,
          realtimeEnabled: false,
          contextualEnabled: false,
        }),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/conversations',
      headers: { authorization: `Bearer ${await accessToken([])}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'DIRECT_MESSAGING_DISABLED' });
  });

  it('issues a realtime ticket only when the realtime tenant gate is enabled', async () => {
    const issue = vi.fn().mockResolvedValue({
      ticketId: '77777777-7777-4777-8777-777777777777',
      ticket: 'signed-realtime-ticket',
      expiresAt: '2026-07-26T12:00:30.000Z',
    });
    const recordRealtimeTicketIssued = vi.fn().mockResolvedValue(undefined);
    const messagingRepository = repository({
      getRuntimeSettings: vi
        .fn()
        .mockResolvedValueOnce({
          httpEnabled: true,
          directEnabled: true,
          realtimeEnabled: false,
          contextualEnabled: false,
        })
        .mockResolvedValueOnce({
          httpEnabled: true,
          directEnabled: true,
          realtimeEnabled: true,
          contextualEnabled: false,
        }),
      recordRealtimeTicketIssued,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository,
      realtimeTicketIssuer: { issue },
    });
    apps.push(app);

    const disabled = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/realtime/tickets',
      headers: { authorization: `Bearer ${await accessToken([])}` },
    });
    const enabled = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/realtime/tickets',
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'x-correlation-id': 'realtime-ticket-correlation-0001',
      },
    });

    expect(disabled.statusCode).toBe(404);
    expect(disabled.json()).toMatchObject({ code: 'REALTIME_MESSAGING_DISABLED' });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({
      ticket: 'signed-realtime-ticket',
      expiresAt: '2026-07-26T12:00:30.000Z',
    });
    expect(issue).toHaveBeenCalledWith({
      tenantId,
      tenantKey: 'local-padel',
      userId,
      sessionId: '55555555-5555-4555-8555-555555555555',
    });
    expect(recordRealtimeTicketIssued).toHaveBeenCalledWith({
      tenantId,
      userId,
      ticketId: '77777777-7777-4777-8777-777777777777',
      expiresAt: '2026-07-26T12:00:30.000Z',
      correlationId: 'realtime-ticket-correlation-0001',
    });
  });

  it('returns only the authenticated member conversation list without caching', async () => {
    const listConversations = vi.fn().mockResolvedValue([]);
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({ listConversations }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/conversations?limit=25',
      headers: { authorization: `Bearer ${await accessToken([])}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [] });
    expect(listConversations).toHaveBeenCalledWith({ tenantId, userId, limit: 25 });
  });

  it('requires the direct-chat permission and an idempotency key to create a dialog', async () => {
    const messagingRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository,
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/direct',
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'idempotency-key': 'direct-command-0001',
      },
      payload: { otherUserId },
    });
    const missingKey = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/direct',
      headers: { authorization: `Bearer ${await accessToken()}` },
      payload: { otherUserId },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'CHAT_PERMISSION_REQUIRED' });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('normalizes and sends a text message through the idempotent repository command', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      outcome: 'ok',
      message: {
        id: messageId,
        conversationId,
        sequence: 1,
        sender: { userId, displayName: 'Анна' },
        messageType: 'TEXT',
        body: 'Привет',
        createdAt: '2026-07-26T12:00:00.000Z',
      },
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({ sendMessage }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'idempotency-key': 'message-command-0001',
        'x-correlation-id': 'message-correlation-0001',
      },
      payload: { clientMessageId: 'client-message-0001', body: '  Привет  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith({
      tenantId,
      userId,
      conversationId,
      clientMessageId: 'client-message-0001',
      idempotencyKey: 'message-command-0001',
      body: 'Привет',
      correlationId: 'message-correlation-0001',
    });
  });

  it('maps membership denial and idempotency conflict to stable errors', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        listMessages: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
        sendMessage: vi.fn().mockResolvedValue({ outcome: 'idempotency_conflict' }),
      }),
    });
    apps.push(app);

    const history = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${await accessToken([])}` },
    });
    const send = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'idempotency-key': 'message-command-0001',
      },
      payload: { clientMessageId: 'client-message-0001', body: 'Привет' },
    });

    expect(history.statusCode).toBe(404);
    expect(history.json()).toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
