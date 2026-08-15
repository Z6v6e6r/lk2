import { createLogger } from '@phub/observability';
import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimeEventDeduplicator,
  registerMessagingRealtimeConsumer,
} from './message-consumer.js';

function eventMessage(payload: unknown) {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { routingKey: 'messaging.message.created.v1' },
  };
}

describe('messaging realtime RabbitMQ consumer', () => {
  it('uses durable ordered delivery and projects identifier-only events', async () => {
    let handler: ((message: never) => void) | undefined;
    const ack = vi.fn();
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handler = callback;
        return Promise.resolve({ consumerTag: 'consumer-1' });
      }),
      ack,
      nack: vi.fn(),
      sendToQueue: vi.fn(),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
    const publish = vi.fn().mockResolvedValue(1);
    const onConsumerFailure = vi.fn();
    const onProjected = vi.fn();

    await registerMessagingRealtimeConsumer({
      channel: channel as never,
      logger: createLogger('realtime-consumer-test', 'silent'),
      publish,
      onConsumerFailure,
      onProjected,
    });
    expect(channel.prefetch).toHaveBeenCalledWith(1);
    expect(channel.assertQueue).toHaveBeenCalledWith('', {
      exclusive: true,
      autoDelete: true,
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'queue',
      'phub.events',
      'messaging.message.created.v1',
    );

    const message = eventMessage({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'messaging.message.created.v1',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-07-26T12:00:00.000Z',
      correlationId: 'message-correlation-0001',
      payload: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
      },
    });
    handler?.(message as never);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(message));
    expect(JSON.stringify(publish.mock.calls)).not.toContain('body');
    expect(onProjected).toHaveBeenCalledWith(1);
    expect(onConsumerFailure).not.toHaveBeenCalled();
  });

  it('quarantines invalid input and fails the consumer on transient projection errors', async () => {
    let handler: ((message: never) => void) | undefined;
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handler = callback;
        return Promise.resolve({ consumerTag: 'consumer-1' });
      }),
      ack: vi.fn(),
      nack: vi.fn(),
      sendToQueue: vi.fn(),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
    const publish = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const onConsumerFailure = vi.fn();
    const onQuarantined = vi.fn();
    await registerMessagingRealtimeConsumer({
      channel: channel as never,
      logger: createLogger('realtime-consumer-test', 'silent'),
      publish,
      onConsumerFailure,
      onQuarantined,
    });

    const invalid = eventMessage({ body: 'must-never-cross-broker' });
    handler?.(invalid as never);
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledWith(invalid));
    expect(channel.waitForConfirms).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'phub.realtime.messaging.quarantine.v1',
      expect.any(Buffer),
      { persistent: true, contentType: 'application/json' },
    );
    const quarantineBody = String(channel.sendToQueue.mock.calls[0]?.[1]);
    expect(quarantineBody).toContain('contentSha256');
    expect(quarantineBody).not.toContain('must-never-cross-broker');
    expect(publish).not.toHaveBeenCalled();
    expect(onQuarantined).toHaveBeenCalledOnce();

    const valid = eventMessage({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'messaging.message.created.v1',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-07-26T12:00:00.000Z',
      correlationId: 'message-correlation-0001',
      payload: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
      },
    });
    handler?.(valid as never);
    await vi.waitFor(() => expect(onConsumerFailure).toHaveBeenCalledWith('projection_failed'));
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('deduplicates an outbox event id within one realtime replica and across Rabbit reconnects', async () => {
    const handlers: ((message: never) => void)[] = [];
    const ack = vi.fn();
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handlers.push(callback);
        return Promise.resolve({ consumerTag: `consumer-${handlers.length}` });
      }),
      ack,
      nack: vi.fn(),
      sendToQueue: vi.fn(),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
    const publish = vi.fn().mockResolvedValue(2);
    const deduplicator = createRealtimeEventDeduplicator(2);
    const options = {
      channel: channel as never,
      logger: createLogger('realtime-consumer-dedupe-test', 'silent'),
      publish,
      onConsumerFailure: vi.fn(),
      deduplicator,
    };
    await registerMessagingRealtimeConsumer(options);
    await registerMessagingRealtimeConsumer(options);

    const firstDelivery = eventMessage({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'messaging.message.created.v1',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-07-26T12:00:00.000Z',
      correlationId: 'message-correlation-0001',
      payload: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
      },
    });
    handlers[0]?.(firstDelivery as never);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(firstDelivery));

    const redeliveryAfterReconnect = eventMessage(
      JSON.parse(firstDelivery.content.toString('utf8')) as unknown,
    );
    handlers[1]?.(redeliveryAfterReconnect as never);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(redeliveryAfterReconnect));

    expect(publish).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('atomically deduplicates concurrent redelivery across reconnect generations', async () => {
    const handlers: ((message: never) => void)[] = [];
    const ack = vi.fn();
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handlers.push(callback);
        return Promise.resolve({ consumerTag: `consumer-${handlers.length}` });
      }),
      ack,
      nack: vi.fn(),
      sendToQueue: vi.fn(),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
    let finishPublish: ((delivered: number) => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishPublish = resolve;
        }),
    );
    const deduplicator = createRealtimeEventDeduplicator(2);
    const options = {
      channel: channel as never,
      logger: createLogger('realtime-consumer-concurrent-dedupe-test', 'silent'),
      publish,
      onConsumerFailure: vi.fn(),
      deduplicator,
    };
    await registerMessagingRealtimeConsumer(options);
    await registerMessagingRealtimeConsumer(options);

    const payload = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'messaging.message.created.v1',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-07-26T12:00:00.000Z',
      correlationId: 'message-correlation-0001',
      payload: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
      },
    };
    const firstDelivery = eventMessage(payload);
    const concurrentRedelivery = eventMessage(payload);
    handlers[0]?.(firstDelivery as never);
    handlers[1]?.(concurrentRedelivery as never);

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(ack).not.toHaveBeenCalled();
    finishPublish?.(2);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2));

    expect(ack).toHaveBeenCalledWith(firstDelivery);
    expect(ack).toHaveBeenCalledWith(concurrentRedelivery);
    expect(options.onConsumerFailure).not.toHaveBeenCalled();
  });

  it('invalidates without ack when quarantine confirmation fails', async () => {
    let handler: ((message: never) => void) | undefined;
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ queue: 'queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn((_, callback: (message: never) => void) => {
        handler = callback;
        return Promise.resolve({ consumerTag: 'consumer-1' });
      }),
      ack: vi.fn(),
      nack: vi.fn(),
      sendToQueue: vi.fn(),
      waitForConfirms: vi.fn().mockRejectedValue(new Error('confirm unavailable')),
    };
    const onConsumerFailure = vi.fn();
    await registerMessagingRealtimeConsumer({
      channel: channel as never,
      logger: createLogger('realtime-consumer-test', 'silent'),
      publish: vi.fn(),
      onConsumerFailure,
    });

    const invalid = eventMessage({ body: 'must-never-enter-quarantine' });
    handler?.(invalid as never);

    await vi.waitFor(() => expect(onConsumerFailure).toHaveBeenCalledWith('projection_failed'));
    expect(channel.ack).not.toHaveBeenCalled();
    const quarantineBody = String(channel.sendToQueue.mock.calls[0]?.[1]);
    expect(quarantineBody).not.toContain('must-never-enter-quarantine');
  });
});
