import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';

import {
  COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE,
  registerCommunityMemberCountProjectorConsumer,
} from './community-member-count-projector-consumer.js';

async function consumerHarness(projectEvent = vi.fn().mockResolvedValue('applied')) {
  let handler: ((message: ConsumeMessage | null) => void) | undefined;
  const channel = {
    assertQueue: vi.fn().mockResolvedValue({ queue: COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE }),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi
      .fn()
      .mockImplementation((_queue: string, callback: (message: ConsumeMessage | null) => void) => {
        handler = callback;
        return Promise.resolve({ consumerTag: 'community-member-count-consumer' });
      }),
    ack: vi.fn(),
    nack: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await registerCommunityMemberCountProjectorConsumer({
    channel: channel as never,
    repository: { projectEvent },
    logger: logger as never,
  });
  return {
    get handler() {
      return handler;
    },
    channel,
    logger,
    projectEvent,
  };
}

const validEnvelope = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  type: 'community.member.joined.v1',
  aggregateId: '11111111-1111-4111-8111-111111111111',
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  payload: {
    communityId: '11111111-1111-4111-8111-111111111111',
    userId: '33333333-3333-4333-8333-333333333333',
  },
} as const;

describe('community member-count projector consumer', () => {
  it('binds only membership-changing events and validates their subject user', async () => {
    let handler: ((message: ConsumeMessage | null) => void) | undefined;
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({ queue: COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi
        .fn()
        .mockImplementation(
          (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
            handler = callback;
            return Promise.resolve({ consumerTag: 'community-member-count-consumer' });
          },
        ),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const projectEvent = vi.fn().mockResolvedValue('applied');
    await registerCommunityMemberCountProjectorConsumer({
      channel: channel as never,
      repository: { projectEvent },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    const envelope = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'community.member.joined.v1',
      aggregateId: '11111111-1111-4111-8111-111111111111',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      payload: {
        communityId: '11111111-1111-4111-8111-111111111111',
        userId: '33333333-3333-4333-8333-333333333333',
      },
    };
    handler?.({ content: Buffer.from(JSON.stringify(envelope)), properties: {} } as never);
    await vi.waitFor(() => expect(projectEvent).toHaveBeenCalledTimes(1));
    expect(projectEvent).toHaveBeenCalledWith({
      tenantId: envelope.tenantId,
      eventId: envelope.id,
      eventType: envelope.type,
      communityId: envelope.payload.communityId,
      userId: envelope.payload.userId,
    });
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('dead-letters malformed JSON and semantically invalid created events without projection', async () => {
    const harness = await consumerHarness();
    harness.handler?.({
      content: Buffer.from('{broken'),
      properties: { messageId: 'broken' },
    } as never);
    harness.handler?.({
      content: Buffer.from(
        JSON.stringify({
          ...validEnvelope,
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          type: 'community.created.v1',
          payload: {
            communityId: validEnvelope.payload.communityId,
            userId: validEnvelope.payload.userId,
          },
        }),
      ),
      properties: { messageId: 'missing-owner' },
    } as never);

    await vi.waitFor(() => expect(harness.channel.nack).toHaveBeenCalledTimes(2));
    expect(harness.projectEvent).not.toHaveBeenCalled();
    expect(harness.channel.nack.mock.calls).toEqual([
      [expect.anything(), false, false],
      [expect.anything(), false, false],
    ]);
    expect(harness.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('requeues a valid event after a transient projection failure and ignores a cancelled delivery', async () => {
    const projectEvent = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const harness = await consumerHarness(projectEvent);
    harness.handler?.(null);
    harness.handler?.({
      content: Buffer.from(JSON.stringify(validEnvelope)),
      properties: { messageId: 'retry-me' },
    } as never);

    await vi.waitFor(() => expect(harness.channel.nack).toHaveBeenCalledOnce());
    expect(harness.channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(harness.channel.ack).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: validEnvelope.id }),
      'community member-count projection failed and will be retried',
    );
  });
});
