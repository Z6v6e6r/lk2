import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { buildRealtimeApp } from './app.js';

const baseConfig = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REALTIME_SECRET: 'test-realtime-secret-distinct-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  COMMUNITIES_READ_MODE: 'local',
  COMMUNITIES_REALTIME_ENABLED: 'true',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '55555555-5555-4555-8555-555555555555';
const communityId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const ticketId = '33333333-3333-4333-8333-333333333333';
const apps: Awaited<ReturnType<typeof buildRealtimeApp>>[] = [];
const sockets: WebSocket[] = [];

function rawDataToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

async function ticket(): Promise<string> {
  return new SignJWT({
    scope: 'realtime.connect',
    tenantId,
    tenantKey: 'local-padel',
    sid: sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(baseConfig.JWT_ISSUER)
    .setAudience(baseConfig.JWT_REALTIME_AUDIENCE)
    .setSubject(userId)
    .setJti(ticketId)
    .setExpirationTime('30s')
    .sign(new TextEncoder().encode(baseConfig.JWT_REALTIME_SECRET));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', (raw: RawData) => {
      const parsed: unknown = JSON.parse(rawDataToText(raw));
      if (typeof parsed !== 'object' || parsed === null) reject(new Error('Expected object'));
      else resolve(parsed as Record<string, unknown>);
    });
  });
}

function nextMessages(
  socket: WebSocket,
  count: number,
): Promise<readonly Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const onError = (error: Error) => {
      socket.off('message', onMessage);
      reject(error);
    };
    const onMessage = (raw: RawData) => {
      const parsed: unknown = JSON.parse(rawDataToText(raw));
      if (typeof parsed !== 'object' || parsed === null) {
        socket.off('error', onError);
        socket.off('message', onMessage);
        reject(new Error('Expected object'));
        return;
      }
      received.push(parsed as Record<string, unknown>);
      if (received.length === count) {
        socket.off('error', onError);
        socket.off('message', onMessage);
        resolve(received);
      }
    };
    socket.once('error', onError);
    socket.on('message', onMessage);
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    config: baseConfig,
    logger: createLogger('realtime-test', 'silent'),
    redis: { ping: vi.fn().mockResolvedValue('PONG') },
    databaseReady: vi.fn().mockResolvedValue(true),
    rabbitReady: vi.fn().mockReturnValue(true),
    ticketConsumer: { consume: vi.fn().mockResolvedValue(true) },
    authorizationRepository: {
      authorizeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
      authorizeCommunitySubscription: vi.fn().mockResolvedValue({
        outcome: 'ok',
        communityRevision: 7,
        membershipRevision: 4,
        latestSequence: 12,
      }),
      authorizeCommunityFanoutRecipients: vi.fn().mockResolvedValue(new Set([sessionId])),
    },
    messagingRepository: {
      authorizeRealtimeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
      authorizeRealtimeSubscription: vi.fn().mockResolvedValue({
        outcome: 'ok',
        latestSequence: 5,
      }),
      listRealtimeRecipientUserIds: vi.fn().mockResolvedValue([userId]),
    },
    ...overrides,
  } as Parameters<typeof buildRealtimeApp>[0];
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe('Communities realtime gateway', () => {
  it('consumes a one-time ticket and authorizes an ACTIVE membership subscription', async () => {
    const consume = vi.fn().mockResolvedValue(true);
    const options = dependencies({ ticketConsumer: { consume } });
    const app = await buildRealtimeApp(options);
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await expect(ready).resolves.toMatchObject({
      type: 'connection.ready',
      communitySubscriptions: true,
    });
    expect(consume).toHaveBeenCalledWith(ticketId, sessionId);

    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'community.subscribe', communityId }));
    await expect(subscribed).resolves.toMatchObject({
      type: 'community.subscribed',
      communityId,
      communityRevision: 7,
      membershipRevision: 4,
      latestSequence: 12,
      delivery: 'DURABLE_SEQUENCE_HTTP_RECOVERY',
    });
    expect(options.authorizationRepository?.authorizeCommunitySubscription).toHaveBeenCalledWith({
      tenantId,
      userId,
      communityId,
      enabled: true,
    });
  });

  it('rejects a replayed ticket and a revoked session before commands', async () => {
    let ticketAvailable = true;
    const authorizeConnection = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'ok' })
      .mockResolvedValue({ outcome: 'revoked' });
    const options = dependencies({
      ticketConsumer: {
        consume: vi.fn().mockImplementation(() => {
          const available = ticketAvailable;
          ticketAvailable = false;
          return Promise.resolve(available);
        }),
      },
      authorizationRepository: {
        authorizeConnection,
        authorizeCommunitySubscription: vi.fn(),
        authorizeCommunityFanoutRecipients: vi.fn(),
      },
    });
    const app = await buildRealtimeApp(options);
    apps.push(app);
    await app.ready();
    const signedTicket = await ticket();
    const first = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(first);
    const ready = nextMessage(first);
    first.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));
    await ready;
    const revoked = new Promise<number>((resolve) => first.once('close', resolve));
    first.send(JSON.stringify({ type: 'ping' }));
    await expect(revoked).resolves.toBe(4401);

    const second = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(second);
    const replayed = new Promise<number>((resolve) => second.once('close', resolve));
    second.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));
    await expect(replayed).resolves.toBe(4401);
  });

  it('fails a non-member subscription closed without exposing community existence', async () => {
    const options = dependencies({
      authorizationRepository: {
        authorizeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
        authorizeCommunitySubscription: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
        authorizeCommunityFanoutRecipients: vi.fn(),
      },
    });
    const app = await buildRealtimeApp(options);
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await ready;
    const denied = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'community.subscribe', communityId }));
    await expect(denied).resolves.toMatchObject({
      type: 'error',
      code: 'COMMUNITY_NOT_FOUND',
      communityId,
    });
  });

  it('reports dependency loss and enforces the pending connection capacity', async () => {
    const unhealthy = await buildRealtimeApp(
      dependencies({ redis: { ping: vi.fn().mockRejectedValue(new Error('offline')) } }),
    );
    apps.push(unhealthy);
    const readiness = await unhealthy.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ redis: false, database: true });

    const capacity = await buildRealtimeApp(
      dependencies({ config: { ...baseConfig, REALTIME_MAX_CONNECTIONS: 1 } }),
    );
    apps.push(capacity);
    await capacity.ready();
    const pending = await capacity.injectWS('/realtime/v1/local-padel');
    sockets.push(pending);
    const rejected = await capacity.injectWS('/realtime/v1/local-padel');
    sockets.push(rejected);
    const closed = new Promise<number>((resolve) => rejected.once('close', resolve));
    await expect(closed).resolves.toBe(1013);
  });

  it('does not register a socket closed while PostgreSQL authority is pending', async () => {
    let resolveAuthority!: (value: { outcome: 'ok' }) => void;
    const pendingAuthority = new Promise<{ outcome: 'ok' }>((resolve) => {
      resolveAuthority = resolve;
    });
    const authorizeConnection = vi.fn().mockReturnValue(pendingAuthority);
    const app = await buildRealtimeApp(
      dependencies({
        authorizationRepository: {
          authorizeConnection,
          authorizeCommunitySubscription: vi.fn(),
          authorizeCommunityFanoutRecipients: vi.fn(),
        },
      }),
    );
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await vi.waitFor(() => expect(authorizeConnection).toHaveBeenCalledTimes(1));
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.terminate();
    await closed;
    resolveAuthority({ outcome: 'ok' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(authorizeConnection).toHaveBeenCalledTimes(1);
  });

  it('fans out identifier-only events after batched membership and session reauthorization', async () => {
    const authorizeCommunityFanoutRecipients = vi.fn().mockResolvedValue(new Set([sessionId]));
    const app = await buildRealtimeApp(
      dependencies({
        authorizationRepository: {
          authorizeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
          authorizeCommunitySubscription: vi.fn().mockResolvedValue({
            outcome: 'ok',
            communityRevision: 7,
            membershipRevision: 4,
            latestSequence: 12,
          }),
          authorizeCommunityFanoutRecipients,
        },
      }),
    );
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await ready;
    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'community.subscribe', communityId }));
    await subscribed;

    const event = nextMessage(socket);
    await app.publishCommunityEvent({
      tenantId,
      communityId,
      sequence: 13,
      eventType: 'community.post.edited.v1',
      targetType: 'POST',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetRevision: 5,
      targetStatus: 'PUBLISHED',
      occurredAt: '2026-08-04T13:00:00.000Z',
    });
    await expect(event).resolves.toEqual({
      type: 'community.event',
      communityId,
      sequence: 13,
      eventType: 'community.post.edited.v1',
      targetType: 'POST',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetRevision: 5,
      targetStatus: 'PUBLISHED',
      occurredAt: '2026-08-04T13:00:00.000Z',
    });
    expect(authorizeCommunityFanoutRecipients).toHaveBeenCalledWith({
      tenantId,
      communityId,
      recipients: [{ userId, sessionId }],
    });

    await app.publishCommunityEvent({
      tenantId,
      communityId,
      sequence: 13,
      eventType: 'community.post.edited.v1',
      targetType: 'POST',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetRevision: 5,
      targetStatus: 'PUBLISHED',
      occurredAt: '2026-08-04T13:00:00.000Z',
    });
    expect(authorizeCommunityFanoutRecipients).toHaveBeenCalledTimes(1);
  });
});

describe('messaging realtime gateway compatibility', () => {
  it('subscribes with an HTTP recovery gap and fans out message identifiers', async () => {
    const options = dependencies();
    const app = await buildRealtimeApp(options);
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await ready;

    const subscriptionMessages = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({ type: 'conversation.subscribe', conversationId, afterSequence: 2 }),
    );
    const [subscribed, gap] = await subscriptionMessages;
    expect(subscribed).toMatchObject({
      type: 'conversation.subscribed',
      conversationId,
      latestSequence: 5,
    });
    expect(gap).toMatchObject({
      type: 'conversation.gap',
      conversationId,
      afterSequence: 2,
      latestSequence: 5,
      reset: false,
      recovery: 'HTTP',
    });

    const delivered = nextMessage(socket);
    await expect(
      app.publishMessageCreated({
        tenantId,
        conversationId,
        messageId: '44444444-4444-4444-8444-444444444444',
        sequence: 6,
        correlationId: 'correlation-1234',
        occurredAt: '2026-08-04T13:00:00.000Z',
      }),
    ).resolves.toBe(1);
    await expect(delivered).resolves.toEqual({
      type: 'message.created',
      conversationId,
      messageId: '44444444-4444-4444-8444-444444444444',
      sequence: 6,
      correlationId: 'correlation-1234',
      occurredAt: '2026-08-04T13:00:00.000Z',
    });
  });

  it('keeps RabbitMQ readiness mandatory when Communities realtime is disabled', async () => {
    const app = await buildRealtimeApp(
      dependencies({
        config: { ...baseConfig, COMMUNITIES_REALTIME_ENABLED: false },
        rabbitReady: vi.fn().mockReturnValue(false),
      }),
    );
    apps.push(app);
    const readiness = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ rabbit: false, communities: false });
  });

  it('rejects conversation commands after messaging capability is revoked', async () => {
    const authorizeRealtimeConnection = vi.fn().mockResolvedValue({ outcome: 'revoked' });
    const authorizeRealtimeSubscription = vi.fn();
    const app = await buildRealtimeApp(
      dependencies({
        messagingRepository: {
          authorizeRealtimeConnection,
          authorizeRealtimeSubscription,
          listRealtimeRecipientUserIds: vi.fn(),
        },
      }),
    );
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await ready;
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(
      JSON.stringify({ type: 'conversation.subscribe', conversationId, afterSequence: 0 }),
    );
    await expect(closed).resolves.toBe(4401);
    expect(authorizeRealtimeSubscription).not.toHaveBeenCalled();
  });
});
