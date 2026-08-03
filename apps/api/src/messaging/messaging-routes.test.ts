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
const gameId = '44444444-4444-4444-8444-444444444444';
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
    getOrCreateGameConversation: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
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
    authorizeRealtimeConnection: vi.fn().mockResolvedValue({ outcome: 'disabled' }),
    authorizeRealtimeSubscription: vi.fn().mockResolvedValue({ outcome: 'disabled' }),
    listRealtimeRecipientUserIds: vi.fn().mockResolvedValue([]),
    recordRealtimeTicketIssued: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('messaging User API', () => {
  it('issues an audited realtime ticket only after current session authorization', async () => {
    const authorizeRealtimeConnection = vi.fn().mockResolvedValue({ outcome: 'ok' });
    const recordRealtimeTicketIssued = vi
      .fn<MessagingRepository['recordRealtimeTicketIssued']>()
      .mockResolvedValue(undefined);
    const issue = vi.fn().mockResolvedValue({
      ticketId: '77777777-7777-4777-8777-777777777777',
      ticket: 'signed-ticket',
      expiresAt: '2026-08-03T12:00:30.000Z',
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({ authorizeRealtimeConnection, recordRealtimeTicketIssued }),
      realtimeTicketIssuer: { issue, revoke: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/messaging/realtime-ticket',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ticket: 'signed-ticket',
      expiresAt: '2026-08-03T12:00:30.000Z',
    });
    expect(authorizeRealtimeConnection).toHaveBeenCalledWith({
      tenantId,
      userId,
      sessionId: '55555555-5555-4555-8555-555555555555',
    });
    expect(recordRealtimeTicketIssued).toHaveBeenCalledOnce();
    const recordedTicket = recordRealtimeTicketIssued.mock.calls[0]?.[0];
    expect(recordedTicket).toMatchObject({
      tenantId,
      userId,
      ticketId: '77777777-7777-4777-8777-777777777777',
      expiresAt: '2026-08-03T12:00:30.000Z',
    });
    expect(typeof recordedTicket?.correlationId).toBe('string');
  });

  it('rejects an unauthenticated request before consulting messaging state', async () => {
    const getRuntimeSettings = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({ getRuntimeSettings }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/conversations',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(getRuntimeSettings).not.toHaveBeenCalled();
  });

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

  it('lists GAME conversations when contextual is enabled and direct is disabled', async () => {
    const listConversations = vi.fn().mockResolvedValue([
      {
        id: conversationId,
        kind: 'GAME',
        contextId: gameId,
        title: 'Игра',
        unreadCount: 0,
        updatedAt: '2026-08-03T12:00:00.000Z',
      },
    ]);
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        getRuntimeSettings: vi.fn().mockResolvedValue({
          httpEnabled: true,
          directEnabled: false,
          realtimeEnabled: false,
          contextualEnabled: true,
        }),
        listConversations,
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/conversations',
      headers: { authorization: `Bearer ${await accessToken(['games.play'])}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ kind: 'GAME', contextId: gameId }] });
  });

  it.each([
    { directEnabled: false, contextualEnabled: false },
    { directEnabled: false, contextualEnabled: true },
    { directEnabled: true, contextualEnabled: false },
    { directEnabled: true, contextualEnabled: true },
  ])(
    'enforces independent direct/contextual gates for $directEnabled/$contextualEnabled',
    async ({ directEnabled, contextualEnabled }) => {
      const createDirectConversation = vi.fn().mockResolvedValue({
        outcome: 'ok',
        conversation: {
          id: conversationId,
          kind: 'DIRECT',
          participant: { userId: otherUserId, displayName: 'Борис' },
          unreadCount: 0,
          updatedAt: '2026-08-03T12:00:00.000Z',
        },
        created: true,
        replayed: false,
      });
      const getOrCreateGameConversation = vi.fn().mockResolvedValue({
        outcome: 'ok',
        conversation: {
          id: conversationId,
          kind: 'GAME',
          contextId: gameId,
          title: 'Игра',
          unreadCount: 0,
          updatedAt: '2026-08-03T12:00:00.000Z',
        },
        created: true,
        replayed: false,
      });
      const app = await buildApp({
        config,
        logger: createLogger('messaging-api-test', 'silent'),
        pool: fakePool(),
        messagingRepository: repository({
          getRuntimeSettings: vi.fn().mockResolvedValue({
            httpEnabled: true,
            directEnabled,
            realtimeEnabled: false,
            contextualEnabled,
          }),
          createDirectConversation,
          getOrCreateGameConversation,
        }),
      });
      apps.push(app);

      const directResponse = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/conversations/direct',
        headers: {
          authorization: `Bearer ${await accessToken(['chat.direct.create'])}`,
          'idempotency-key': 'direct-gate-matrix-0001',
        },
        payload: { otherUserId },
      });
      const gameResponse = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/conversations/game',
        headers: {
          authorization: `Bearer ${await accessToken(['games.play'])}`,
          'idempotency-key': 'game-gate-matrix-0001',
        },
        payload: { gameId },
      });

      expect(directResponse.statusCode).toBe(directEnabled ? 200 : 404);
      expect(gameResponse.statusCode).toBe(contextualEnabled ? 200 : 404);
      expect(createDirectConversation).toHaveBeenCalledTimes(directEnabled ? 1 : 0);
      expect(getOrCreateGameConversation).toHaveBeenCalledTimes(contextualEnabled ? 1 : 0);
    },
  );

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

  it('does not reveal whether a direct-chat target is missing, inactive or privacy-restricted', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        createDirectConversation: vi.fn().mockResolvedValue({ outcome: 'target_not_found' }),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/direct',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'direct-command-0001',
      },
      payload: { otherUserId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'CHAT_PARTICIPANT_NOT_FOUND' });
  });

  it('keeps game conversations closed until contextual messaging is explicitly enabled', async () => {
    const getOrCreateGameConversation = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({ getOrCreateGameConversation }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/game',
      headers: {
        authorization: `Bearer ${await accessToken(['games.play'])}`,
        'idempotency-key': 'game-chat-command-0001',
        'x-correlation-id': 'game-chat-correlation-0001',
      },
      payload: { gameId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'CONTEXTUAL_MESSAGING_DISABLED' });
    expect(getOrCreateGameConversation).not.toHaveBeenCalled();
  });

  it('gets or creates a game conversation only for a games.play principal', async () => {
    const getOrCreateGameConversation = vi.fn().mockResolvedValue({
      outcome: 'ok',
      conversation: {
        id: conversationId,
        kind: 'GAME',
        contextId: gameId,
        title: 'Игра в среду',
        unreadCount: 0,
        updatedAt: '2026-08-03T12:00:00.000Z',
      },
      created: true,
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: repository({
        getRuntimeSettings: vi.fn().mockResolvedValue({
          httpEnabled: true,
          directEnabled: false,
          realtimeEnabled: false,
          contextualEnabled: true,
        }),
        getOrCreateGameConversation,
      }),
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/game',
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'idempotency-key': 'game-chat-command-0001',
      },
      payload: { gameId },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/conversations/game',
      headers: {
        authorization: `Bearer ${await accessToken(['games.play'])}`,
        'idempotency-key': 'game-chat-command-0001',
        'x-correlation-id': 'game-chat-correlation-0001',
      },
      payload: { gameId },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(getOrCreateGameConversation).toHaveBeenCalledWith({
      tenantId,
      actorUserId: userId,
      gameId,
      idempotencyKey: 'game-chat-command-0001',
      correlationId: 'game-chat-correlation-0001',
    });
  });

  it('rejects send when direct-chat permission was revoked without calling the repository', async () => {
    const sendMessage = vi.fn();
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
      },
      payload: { clientMessageId: 'client-message-0001', body: 'Привет' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CHAT_PERMISSION_REQUIRED' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('allows a games.play principal to reach kind-aware repository authorization', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ outcome: 'not_found' });
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
        authorization: `Bearer ${await accessToken(['games.play'])}`,
        'idempotency-key': 'game-message-command-0001',
      },
      payload: { clientMessageId: 'game-client-message-0001', body: 'Готов' },
    });

    expect(response.statusCode).toBe(404);
    expect(sendMessage).toHaveBeenCalledOnce();
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
        authorization: `Bearer ${await accessToken()}`,
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
        authorization: `Bearer ${await accessToken()}`,
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
