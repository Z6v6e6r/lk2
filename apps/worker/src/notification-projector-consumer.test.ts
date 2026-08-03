import { describe, expect, it, vi } from 'vitest';

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
});
