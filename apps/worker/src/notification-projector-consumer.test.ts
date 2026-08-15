import { describe, expect, it, vi } from 'vitest';

const projector = vi.hoisted(() => ({ applyNotificationSourceEvent: vi.fn() }));

vi.mock('./notification-projector.js', () => projector);

import {
  NOTIFICATION_PROJECTOR_QUEUE,
  NOTIFICATION_SOURCE_ROUTING_KEYS,
  registerNotificationProjectorConsumer,
} from './notification-projector-consumer.js';

describe('notification projector topology', () => {
  it('binds only explicit booking source events and removes the legacy wildcard', async () => {
    const timeline: string[] = [];
    const channel = {
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn((_queue: string, _exchange: string, routingKey: string) => {
        timeline.push(`bind:${routingKey}`);
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
    expect(channel.bindQueue.mock.calls.map((call) => call[2])).toEqual(
      NOTIFICATION_SOURCE_ROUTING_KEYS,
    );
    expect(channel.bindQueue).not.toHaveBeenCalledWith(
      NOTIFICATION_PROJECTOR_QUEUE,
      'phub.events',
      '#',
    );
    expect(timeline).toEqual([
      ...NOTIFICATION_SOURCE_ROUTING_KEYS.map((routingKey) => `bind:${routingKey}`),
      'unbind:#',
    ]);
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
