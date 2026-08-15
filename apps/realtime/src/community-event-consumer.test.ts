import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';

import { registerCommunityEventConsumer } from './community-event-consumer.js';

const event = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  type: 'community.post.edited.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  occurredAt: '2026-08-04T13:00:00.000Z',
  correlationId: 'community-event-correlation',
  payload: {
    communityId: '11111111-1111-4111-8111-111111111111',
    sequence: 13,
    targetType: 'POST',
    targetId: '22222222-2222-4222-8222-222222222222',
    revision: 5,
    status: 'PUBLISHED',
  },
};

describe('community realtime event consumer', () => {
  it('binds only accepted content events and fans out an identifier-only hint', async () => {
    let handler: ((message: ConsumeMessage | null) => void) | undefined;
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({ queue: 'generated-instance-queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi
        .fn()
        .mockImplementation(
          (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
            handler = callback;
            return Promise.resolve({ consumerTag: 'community-realtime-consumer' });
          },
        ),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const publishCommunityEvent = vi.fn().mockResolvedValue(undefined);
    const metrics = {
      recordCommunityFanoutHint: vi.fn(),
    };
    await expect(
      registerCommunityEventConsumer({
        channel: channel as never,
        target: { publishCommunityEvent },
        logger: { warn: vi.fn(), error: vi.fn() } as never,
        metrics: metrics as never,
      }),
    ).resolves.toBe('community-realtime-consumer');
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'generated-instance-queue',
      'phub.events',
      'community.post.edited.v1',
    );
    handler?.({
      content: Buffer.from(JSON.stringify(event)),
      properties: { messageId: event.id },
    } as never);
    await vi.waitFor(() => expect(publishCommunityEvent).toHaveBeenCalledTimes(1));
    expect(publishCommunityEvent).toHaveBeenCalledWith({
      tenantId: event.tenantId,
      communityId: event.payload.communityId,
      sequence: 13,
      eventType: event.type,
      targetType: 'POST',
      targetId: event.payload.targetId,
      targetRevision: 5,
      targetStatus: 'PUBLISHED',
      occurredAt: event.occurredAt,
    });
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(metrics.recordCommunityFanoutHint).toHaveBeenCalledWith('accepted');
  });

  it('records a bounded failure metric and preserves safe broker correlation in logs', async () => {
    let handler: ((message: ConsumeMessage | null) => void) | undefined;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const metrics = {
      recordCommunityFanoutHint: vi.fn(),
      recordCommunityFanoutFailure: vi.fn(),
    };
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({ queue: 'generated-instance-queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi
        .fn()
        .mockImplementation(
          (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
            handler = callback;
            return Promise.resolve({ consumerTag: 'community-realtime-consumer' });
          },
        ),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    await registerCommunityEventConsumer({
      channel: channel as never,
      target: { publishCommunityEvent: vi.fn().mockRejectedValue(new Error('fanout failed')) },
      logger: logger as never,
      metrics: metrics as never,
    });

    handler?.({
      content: Buffer.from(JSON.stringify(event)),
      properties: { messageId: event.id, correlationId: event.correlationId },
    } as never);

    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledTimes(1));
    expect(metrics.recordCommunityFanoutHint).toHaveBeenCalledWith('fanout_failed');
    expect(metrics.recordCommunityFanoutFailure).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: event.id,
        correlationId: event.correlationId,
        sequence: event.payload.sequence,
      }),
      expect.stringContaining('clients must recover over HTTP'),
    );
  });
});
