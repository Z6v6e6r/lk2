import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GAME_DOMAIN_EVENT_TYPES, consumersForGameEvent, gameDomainEventSchema } from '@phub/games';
import { GAME_NOTIFICATION_EVENT_TYPES, notificationSourceEventSchema } from '@phub/notifications';

const projector = vi.hoisted(() => ({ applyNotificationSourceEvent: vi.fn() }));

vi.mock('./notification-projector.js', () => projector);

import {
  GAME_NOTIFICATION_PROJECTOR_QUEUE,
  GAME_NOTIFICATION_SOURCE_ROUTING_KEYS,
  NOTIFICATION_PROJECTOR_QUEUE,
  NOTIFICATION_SOURCE_ROUTING_KEYS,
  registerNotificationProjectorConsumer,
} from './notification-projector-consumer.js';

describe('notification projector topology', () => {
  beforeEach(() => {
    projector.applyNotificationSourceEvent.mockReset();
  });

  it('keeps every notification GAME contract compatible with the Core Game event catalog', () => {
    const gameId = '22222222-2222-4222-8222-222222222222';
    const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
    const base = {
      aggregateId: gameId,
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-08-31T12:00:00.000Z',
      correlationId: 'game-notification-contract-test',
    };
    const payloadBase = {
      gameId,
      causationId: '33333333-3333-4333-8333-333333333333',
      actorUserId: userId,
    };
    const fixtures = [
      {
        ...base,
        id: '11111111-1111-4111-8111-111111111111',
        type: 'game.participation.confirmed.v1',
        payload: {
          ...payloadBase,
          aggregateRevision: '2',
          userId,
          participationId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        ...base,
        id: '51111111-1111-4111-8111-111111111111',
        type: 'game.participation.left.v1',
        payload: {
          ...payloadBase,
          aggregateRevision: '3',
          userId,
          participationId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        ...base,
        id: '61111111-1111-4111-8111-111111111111',
        type: 'game.cancelled.v1',
        payload: {
          ...payloadBase,
          aggregateRevision: '4',
          participantUserIds: [userId],
          reasonCode: 'ORGANIZER_REQUEST',
        },
      },
    ] as const;

    for (const type of GAME_NOTIFICATION_EVENT_TYPES) {
      expect(GAME_DOMAIN_EVENT_TYPES).toContain(type);
      expect(consumersForGameEvent(type)).toContain('notifications-rules');
      const fixture = fixtures.find((candidate) => candidate.type === type);
      expect(fixture).toBeDefined();
      expect(gameDomainEventSchema.parse(fixture)).toEqual(
        notificationSourceEventSchema.parse(fixture),
      );
    }
  });

  it('binds only explicit booking and GAME source events and removes the legacy wildcard', async () => {
    const timeline: string[] = [];
    const channel = {
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn((queue: string, _exchange: string, routingKey: string) => {
        timeline.push(`bind:${queue}:${routingKey}`);
        return Promise.resolve();
      }),
      unbindQueue: vi.fn((_queue: string, _exchange: string, routingKey: string) => {
        timeline.push(`unbind:${routingKey}`);
        return Promise.resolve();
      }),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'notification-projector-test' }),
    };

    await expect(
      registerNotificationProjectorConsumer({
        channel: channel as never,
        pool: {} as never,
        logger: {} as never,
      }),
    ).resolves.toBe('notification-projector-test');

    expect(channel.assertQueue).toHaveBeenCalledWith(
      NOTIFICATION_PROJECTOR_QUEUE,
      expect.objectContaining({ durable: true }),
    );
    expect(channel.assertQueue).toHaveBeenCalledWith(
      GAME_NOTIFICATION_PROJECTOR_QUEUE,
      expect.objectContaining({ durable: true }),
    );
    expect(
      channel.bindQueue.mock.calls
        .filter((call) => call[0] === NOTIFICATION_PROJECTOR_QUEUE)
        .map((call) => call[2]),
    ).toEqual(NOTIFICATION_SOURCE_ROUTING_KEYS);
    expect(
      channel.bindQueue.mock.calls
        .filter((call) => call[0] === GAME_NOTIFICATION_PROJECTOR_QUEUE)
        .map((call) => call[2]),
    ).toEqual(GAME_NOTIFICATION_SOURCE_ROUTING_KEYS);
    expect(channel.consume).toHaveBeenCalledWith(
      GAME_NOTIFICATION_PROJECTOR_QUEUE,
      expect.any(Function),
      { noAck: false },
    );
    expect(channel.bindQueue).not.toHaveBeenCalledWith(
      NOTIFICATION_PROJECTOR_QUEUE,
      'phub.events',
      '#',
    );
    expect(timeline).toEqual([
      ...NOTIFICATION_SOURCE_ROUTING_KEYS.map(
        (routingKey) => `bind:${NOTIFICATION_PROJECTOR_QUEUE}:${routingKey}`,
      ),
      ...GAME_NOTIFICATION_SOURCE_ROUTING_KEYS.map(
        (routingKey) => `bind:${GAME_NOTIFICATION_PROJECTOR_QUEUE}:${routingKey}`,
      ),
      'unbind:#',
    ]);
  });

  it('accepts a strict GAME participation event for projection', async () => {
    const handlers: Array<
      (message: { content: Buffer; properties: { messageId: string } }) => void
    > = [];
    const channel = {
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      unbindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_queue: string, handler: (message: never) => void) => {
        handlers.push(handler as never);
        return Promise.resolve({ consumerTag: 'notification-projector-test' });
      }),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await registerNotificationProjectorConsumer({
      channel: channel as never,
      pool: {} as never,
      logger: logger as never,
    });
    const gameId = '22222222-2222-4222-8222-222222222222';
    const message = {
      content: Buffer.from(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          type: 'game.participation.confirmed.v1',
          aggregateId: gameId,
          tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
          occurredAt: '2026-08-31T12:00:00.000Z',
          correlationId: 'game-notification-consumer-test',
          payload: {
            gameId,
            aggregateRevision: '2',
            causationId: '33333333-3333-4333-8333-333333333333',
            actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
            userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
            participationId: '44444444-4444-4444-8444-444444444444',
          },
        }),
      ),
      properties: { messageId: 'game-notification-consumer-test' },
    };
    projector.applyNotificationSourceEvent.mockResolvedValueOnce({
      outcome: 'processed',
      created: 1,
      suppressed: 0,
      pushQueued: 0,
      skippedRules: 0,
    });
    handlers[1]?.(message);
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledWith(message));
    expect(projector.applyNotificationSourceEvent).toHaveBeenCalledOnce();
    const projectedInput = projector.applyNotificationSourceEvent.mock.calls[0]?.[0] as unknown as {
      readonly event: { readonly type: string; readonly aggregateId: string };
    };
    expect(projectedInput.event).toMatchObject({
      type: 'game.participation.confirmed.v1',
      aggregateId: gameId,
    });
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('dead-letters terminal revision conflicts but requeues retryable failures', async () => {
    const handlers: Array<
      (message: { content: Buffer; properties: { messageId: string } }) => void
    > = [];
    const channel = {
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      unbindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_queue: string, handler: (message: never) => void) => {
        handlers.push(handler as never);
        return Promise.resolve({ consumerTag: 'notification-projector-test' });
      }),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await registerNotificationProjectorConsumer({
      channel: channel as never,
      pool: {} as never,
      logger: logger as never,
    });
    const message = {
      content: Buffer.from(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          type: 'booking.confirmed.v1',
          aggregateId: '22222222-2222-4222-8222-222222222222',
          tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
          occurredAt: '2026-08-14T12:00:00.000Z',
          correlationId: 'booking-fence-consumer-test',
          payload: {
            bookingId: '22222222-2222-4222-8222-222222222222',
            revision: '1',
            recipientUserIds: ['49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca'],
            serviceTitle: 'Падел',
            startsAt: '2026-08-15T19:00:00+03:00',
            timezone: 'Europe/Moscow',
            locationName: 'ПаделхАБ',
          },
        }),
      ),
      properties: { messageId: 'consumer-fence-test' },
    };
    projector.applyNotificationSourceEvent.mockResolvedValueOnce({ outcome: 'revision_conflict' });
    handlers[0]?.(message);
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledWith(message, false, false));

    projector.applyNotificationSourceEvent.mockRejectedValueOnce(
      new Error('BOOKING_REMINDER_AHEAD_OF_LIFECYCLE'),
    );
    handlers[0]?.(message);
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledWith(message, false, true));
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
