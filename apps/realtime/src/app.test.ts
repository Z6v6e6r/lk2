import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { buildRealtimeApp } from './app.js';

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
const sessionId = '55555555-5555-4555-8555-555555555555';
const conversationId = '11111111-1111-4111-8111-111111111111';
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
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_REALTIME_AUDIENCE)
    .setSubject(userId)
    .setJti(ticketId)
    .setExpirationTime('30s')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe('realtime messaging gateway', () => {
  it('consumes a session-bound ticket, rechecks authority and emits an HTTP gap', async () => {
    const authorizeRealtimeConnection = vi.fn().mockResolvedValue({ outcome: 'ok' });
    const authorizeRealtimeSubscription = vi
      .fn()
      .mockResolvedValue({ outcome: 'ok', latestSequence: 3 });
    const listRealtimeRecipientUserIds = vi.fn().mockResolvedValue([userId]);
    const consume = vi.fn().mockResolvedValue(true);
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: { consume },
      messagingRepository: {
        authorizeRealtimeConnection,
        authorizeRealtimeSubscription,
        listRealtimeRecipientUserIds,
      },
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await expect(ready).resolves.toMatchObject({ type: 'connection.ready' });
    expect(consume).toHaveBeenCalledWith(ticketId, sessionId);
    expect(authorizeRealtimeConnection).toHaveBeenCalledWith({ tenantId, userId, sessionId });

    const messages: Record<string, unknown>[] = [];
    socket.on('message', (raw: RawData) =>
      messages.push(JSON.parse(rawDataToText(raw)) as Record<string, unknown>),
    );
    socket.send(
      JSON.stringify({ type: 'conversation.subscribe', conversationId, afterSequence: 1 }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({
      type: 'conversation.gap',
      afterSequence: 1,
      latestSequence: 3,
      recovery: 'HTTP',
    });

    const projected = nextMessage(socket);
    await expect(
      app.publishMessageCreated({
        tenantId,
        conversationId,
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
        correlationId: 'realtime-correlation-0001',
        occurredAt: '2026-07-26T12:00:00.000Z',
      }),
    ).resolves.toBe(1);
    await expect(projected).resolves.toMatchObject({ type: 'message.created', sequence: 4 });
    expect(authorizeRealtimeConnection).toHaveBeenCalledTimes(3);
  });

  it('does not register a socket closed while connection authority is pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    let resolveAuthority!: (value: { outcome: 'ok' }) => void;
    const pendingAuthority = new Promise<{ outcome: 'ok' }>((resolve) => {
      resolveAuthority = resolve;
    });
    const authorizeRealtimeConnection = vi.fn().mockReturnValue(pendingAuthority);
    const listRealtimeRecipientUserIds = vi.fn().mockResolvedValue([userId]);
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: { consume: vi.fn().mockResolvedValue(true) },
      messagingRepository: {
        authorizeRealtimeConnection,
        authorizeRealtimeSubscription: vi.fn(),
        listRealtimeRecipientUserIds,
      },
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await vi.waitFor(() => expect(authorizeRealtimeConnection).toHaveBeenCalledTimes(1));

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.terminate();
    await closed;
    resolveAuthority({ outcome: 'ok' });
    await nextTurn();

    await expect(
      app.publishMessageCreated({
        tenantId,
        conversationId,
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        correlationId: 'realtime-correlation-close-race',
        occurredAt: '2026-08-04T09:00:00.000Z',
      }),
    ).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(authorizeRealtimeConnection).toHaveBeenCalledTimes(1);
    expect(listRealtimeRecipientUserIds).toHaveBeenCalledTimes(1);
  });

  it('does not register a socket closed by the authentication timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    let resolveAuthority!: (value: { outcome: 'ok' }) => void;
    const pendingAuthority = new Promise<{ outcome: 'ok' }>((resolve) => {
      resolveAuthority = resolve;
    });
    const authorizeRealtimeConnection = vi.fn().mockReturnValue(pendingAuthority);
    const listRealtimeRecipientUserIds = vi.fn().mockResolvedValue([userId]);
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: { consume: vi.fn().mockResolvedValue(true) },
      messagingRepository: {
        authorizeRealtimeConnection,
        authorizeRealtimeSubscription: vi.fn(),
        listRealtimeRecipientUserIds,
      },
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await vi.waitFor(() => expect(authorizeRealtimeConnection).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(closed).resolves.toBe(4401);
    resolveAuthority({ outcome: 'ok' });
    await nextTurn();

    await expect(
      app.publishMessageCreated({
        tenantId,
        conversationId,
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        correlationId: 'realtime-correlation-auth-timeout',
        occurredAt: '2026-08-04T09:00:00.000Z',
      }),
    ).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(authorizeRealtimeConnection).toHaveBeenCalledTimes(1);
    expect(listRealtimeRecipientUserIds).toHaveBeenCalledTimes(1);
  });

  it('rejects a replayed one-time ticket', async () => {
    let available = true;
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: {
        consume: () => {
          const result = available;
          available = false;
          return Promise.resolve(result);
        },
      },
      messagingRepository: {
        authorizeRealtimeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
        authorizeRealtimeSubscription: vi.fn(),
        listRealtimeRecipientUserIds: vi.fn(),
      },
    });
    apps.push(app);
    await app.ready();
    const signedTicket = await ticket();
    const first = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(first);
    const ready = nextMessage(first);
    first.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));
    await ready;
    first.close();
    const second = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(second);
    const closed = new Promise<number>((resolve) => second.once('close', resolve));
    second.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));
    await expect(closed).resolves.toBe(4401);
  });

  it('closes a revoked session before a command is processed', async () => {
    const authorizeRealtimeConnection = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'ok' })
      .mockResolvedValue({ outcome: 'revoked' });
    const subscribe = vi.fn();
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: { consume: vi.fn().mockResolvedValue(true) },
      messagingRepository: {
        authorizeRealtimeConnection,
        authorizeRealtimeSubscription: subscribe,
        listRealtimeRecipientUserIds: vi.fn(),
      },
    });
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
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('reports Rabbit dependency loss through fail-closed readiness', async () => {
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => false,
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ rabbit: false });
  });

  it('closes an authenticated socket that exceeds its command budget', async () => {
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: { consume: vi.fn().mockResolvedValue(true) },
      messagingRepository: {
        authorizeRealtimeConnection: vi.fn().mockResolvedValue({ outcome: 'ok' }),
        authorizeRealtimeSubscription: vi.fn(),
        listRealtimeRecipientUserIds: vi.fn(),
      },
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await ready;
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    for (let index = 0; index < 61; index += 1) socket.send(JSON.stringify({ type: 'ping' }));
    await expect(closed).resolves.toBe(4429);
  });
});
