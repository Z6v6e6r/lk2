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
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const ticketId = '33333333-3333-4333-8333-333333333333';
const apps: Awaited<ReturnType<typeof buildRealtimeApp>>[] = [];
const sockets: WebSocket[] = [];

function rawDataToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

async function ticket(jti = ticketId): Promise<string> {
  return new SignJWT({
    scope: 'realtime.connect',
    tenantId,
    tenantKey: 'local-padel',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_REALTIME_AUDIENCE)
    .setSubject(userId)
    .setJti(jti)
    .setExpirationTime('30s')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', (raw: RawData) => {
      const parsed: unknown = JSON.parse(rawDataToText(raw));
      if (typeof parsed !== 'object' || parsed === null) {
        reject(new Error('Expected object message'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('realtime messaging gateway', () => {
  it('authenticates once, checks membership, reports a gap and fans out identifiers', async () => {
    const consumed = new Set<string>();
    const authorizeRealtimeSubscription = vi.fn().mockResolvedValue({
      outcome: 'ok',
      latestSequence: 3,
    });
    const listRealtimeRecipientUserIds = vi.fn().mockResolvedValue([userId]);
    const app = await buildRealtimeApp({
      config,
      logger: createLogger('realtime-test', 'silent'),
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
      databaseReady: vi.fn().mockResolvedValue(true),
      rabbitReady: () => true,
      ticketConsumer: {
        consume: (jti) => Promise.resolve(!consumed.has(jti) && Boolean(consumed.add(jti))),
      },
      messagingRepository: {
        authorizeRealtimeSubscription,
        listRealtimeRecipientUserIds,
      },
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(socket);

    const readyMessage = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: await ticket() }));
    await expect(readyMessage).resolves.toMatchObject({ type: 'connection.ready' });

    const subscriptionMessages: Record<string, unknown>[] = [];
    socket.on('message', (raw: RawData) => {
      const parsed: unknown = JSON.parse(rawDataToText(raw));
      if (typeof parsed === 'object' && parsed !== null) {
        subscriptionMessages.push(parsed as Record<string, unknown>);
      }
    });
    socket.send(
      JSON.stringify({
        type: 'conversation.subscribe',
        conversationId,
        afterSequence: 1,
      }),
    );
    await vi.waitFor(() => expect(subscriptionMessages).toHaveLength(2));
    expect(subscriptionMessages[0]).toMatchObject({
      type: 'conversation.subscribed',
      conversationId,
      latestSequence: 3,
    });
    expect(subscriptionMessages[1]).toMatchObject({
      type: 'conversation.gap',
      conversationId,
      afterSequence: 1,
      latestSequence: 3,
      recovery: 'HTTP',
    });

    const projectedMessage = nextMessage(socket);
    await expect(
      app.publishMessageCreated({
        tenantId,
        conversationId,
        messageId,
        sequence: 4,
        correlationId: 'realtime-correlation-0001',
        occurredAt: '2026-07-26T12:00:00.000Z',
      }),
    ).resolves.toBe(1);
    await expect(projectedMessage).resolves.toEqual({
      type: 'message.created',
      conversationId,
      messageId,
      sequence: 4,
      correlationId: 'realtime-correlation-0001',
      occurredAt: '2026-07-26T12:00:00.000Z',
    });
    expect(authorizeRealtimeSubscription).toHaveBeenCalledWith({
      tenantId,
      userId,
      conversationId,
    });
    expect(listRealtimeRecipientUserIds).toHaveBeenCalledWith({
      tenantId,
      conversationId,
      messageId,
      sequence: 4,
    });
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
        authorizeRealtimeSubscription: vi.fn(),
        listRealtimeRecipientUserIds: vi.fn(),
      },
    });
    apps.push(app);
    await app.ready();
    const signedTicket = await ticket();
    const first = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(first);
    const readyMessage = nextMessage(first);
    first.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));
    await readyMessage;
    first.close();

    const second = await app.injectWS('/realtime/v1/local-padel');
    sockets.push(second);
    const closed = new Promise<number>((resolve) => {
      second.once('close', (code) => resolve(code));
    });
    second.send(JSON.stringify({ type: 'authenticate', ticket: signedTicket }));

    await expect(closed).resolves.toBe(4401);
  });
});
