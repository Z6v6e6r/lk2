import { createLogger } from '@phub/observability';
import { describe, expect, it, vi } from 'vitest';

import { registerMessagingRealtimeConsumer } from './message-consumer.js';

describe('messaging realtime RabbitMQ consumer', () => {
  it('uses one exclusive instance queue and projects identifier-only events', async () => {
    let handler: ((message: never) => void) | undefined;
    const ack = vi.fn();
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'generated-instance-queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handler = callback;
        return Promise.resolve({ consumerTag: 'consumer-1' });
      }),
      ack,
    };
    const publish = vi.fn().mockResolvedValue(1);

    await expect(
      registerMessagingRealtimeConsumer({
        channel: channel as never,
        logger: createLogger('realtime-consumer-test', 'silent'),
        publish,
      }),
    ).resolves.toEqual({
      queueName: 'generated-instance-queue',
      consumerTag: 'consumer-1',
    });

    expect(channel.assertQueue).toHaveBeenCalledWith('', {
      exclusive: true,
      autoDelete: true,
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'generated-instance-queue',
      'phub.events',
      'messaging.message.created.v1',
    );

    const message = {
      content: Buffer.from(
        JSON.stringify({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          type: 'messaging.message.created.v1',
          aggregateId: '11111111-1111-4111-8111-111111111111',
          tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
          occurredAt: '2026-07-26T12:00:00.000Z',
          correlationId: 'message-correlation-0001',
          payload: {
            conversationId: '11111111-1111-4111-8111-111111111111',
            messageId: '22222222-2222-4222-8222-222222222222',
            sequence: 4,
          },
        }),
      ),
    };
    handler?.(message as never);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(message));

    expect(publish).toHaveBeenCalledWith({
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      conversationId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      sequence: 4,
      correlationId: 'message-correlation-0001',
      occurredAt: '2026-07-26T12:00:00.000Z',
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('body');
  });
});
