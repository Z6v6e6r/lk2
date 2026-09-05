import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GAME_MESSAGING_MEMBERSHIP_QUEUE,
  GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS,
  registerGameMessagingMembershipConsumer,
} from './game-messaging-membership-consumer.js';

const event = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'game.participation.left.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  occurredAt: '2026-09-04T10:00:00.000Z',
  correlationId: 'game-membership-consumer-test',
  payload: {
    gameId: '22222222-2222-4222-8222-222222222222',
    aggregateRevision: '3',
    causationId: '33333333-3333-4333-8333-333333333333',
    actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    participationId: '44444444-4444-4444-8444-444444444444',
  },
} as const;

function fixture() {
  const handlers: Array<(message: never) => void> = [];
  const channel = {
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi
      .fn<(_queue: string, _exchange: string, _routingKey: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn((_queue: string, handler: (message: never) => void) => {
      handlers.push(handler);
      return Promise.resolve({ consumerTag: 'game-membership-test' });
    }),
    ack: vi.fn(),
    nack: vi.fn(),
    reject: vi.fn(),
  };
  const repository = { reconcileGameConversationMembership: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { handlers, channel, repository, logger };
}

function message(value: unknown = event, messageId: string = event.id) {
  return {
    content: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    properties: { messageId },
  };
}

describe('GAME messaging membership consumer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('declares a durable quorum queue with bounded delivery and dead lettering', async () => {
    const state = fixture();
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    expect(state.channel.assertQueue).toHaveBeenCalledWith(GAME_MESSAGING_MEMBERSHIP_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'phub.dead-letter',
      },
    });
  });

  it('binds the complete exact catalog route and no wildcard', async () => {
    const state = fixture();
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    expect(GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS).toEqual([
      'game.scheduled.v1',
      'game.participation.confirmed.v1',
      'game.participation.left.v1',
      'game.cancelled.v1',
    ]);
    expect(state.channel.bindQueue.mock.calls.map((call) => call[2])).toEqual(
      GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS,
    );
    expect(state.channel.bindQueue).not.toHaveBeenCalledWith(
      GAME_MESSAGING_MEMBERSHIP_QUEUE,
      'phub.events',
      '#',
    );
  });

  it('dead-letters invalid JSON without calling the repository', async () => {
    const state = fixture();
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const poison = message('{');
    state.handlers[0]?.(poison as never);
    await vi.waitFor(() => expect(state.channel.nack).toHaveBeenCalledWith(poison, false, false));
    expect(state.repository.reconcileGameConversationMembership).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...event, unexpected: true }, event.id],
    [{ ...event, type: 'game.created.v1' }, event.id],
    [event, '51111111-1111-4111-8111-111111111111'],
  ])('dead-letters an invalid schema, route, or message identity', async (body, messageId) => {
    const state = fixture();
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const poison = message(body, messageId);
    state.handlers[0]?.(poison as never);
    await vi.waitFor(() => expect(state.channel.nack).toHaveBeenCalledWith(poison, false, false));
    expect(state.channel.ack).not.toHaveBeenCalled();
  });

  it('uses basic.reject with requeue for transient database failures', async () => {
    const state = fixture();
    state.repository.reconcileGameConversationMembership.mockRejectedValueOnce(
      new Error('temporary database failure'),
    );
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const delivery = message();
    state.handlers[0]?.(delivery as never);
    await vi.waitFor(() => expect(state.channel.reject).toHaveBeenCalledWith(delivery, true));
    expect(state.channel.ack).not.toHaveBeenCalled();
  });

  it('ACKs exactly once after a successful database settlement', async () => {
    const state = fixture();
    state.repository.reconcileGameConversationMembership.mockResolvedValueOnce({
      outcome: 'applied',
      conversationClosed: false,
      activatedUserIds: [],
      leftUserIds: [event.payload.userId],
    });
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const delivery = message();
    state.handlers[0]?.(delivery as never);
    await vi.waitFor(() => expect(state.channel.ack).toHaveBeenCalledTimes(1));
    expect(state.channel.ack).toHaveBeenCalledWith(delivery);
    expect(JSON.stringify(state.logger.info.mock.calls)).not.toContain(event.payload.userId);
    expect(state.logger.info).toHaveBeenCalledTimes(1);
    expect(state.logger.info.mock.calls[0]?.[1]).toBe('GAME messaging membership reconciled');
    expect(JSON.stringify(state.logger.info.mock.calls[0]?.[0])).toContain('"leftMemberCount":1');
  });

  it('does not ACK before the database promise settles', async () => {
    const state = fixture();
    let settle: ((value: { outcome: 'no_op' }) => void) | undefined;
    state.repository.reconcileGameConversationMembership.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const delivery = message();
    state.handlers[0]?.(delivery as never);
    await Promise.resolve();
    expect(state.channel.ack).not.toHaveBeenCalled();
    settle?.({ outcome: 'no_op' });
    await vi.waitFor(() => expect(state.channel.ack).toHaveBeenCalledWith(delivery));
  });

  it('ACKs an idempotent no-op redelivery without additional broker effects', async () => {
    const state = fixture();
    state.repository.reconcileGameConversationMembership.mockResolvedValue({ outcome: 'no_op' });
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const delivery = message();
    state.handlers[0]?.(delivery as never);
    state.handlers[0]?.(delivery as never);
    await vi.waitFor(() => expect(state.channel.ack).toHaveBeenCalledTimes(2));
    expect(state.channel.nack).not.toHaveBeenCalled();
    expect(state.channel.reject).not.toHaveBeenCalled();
  });

  it('dead-letters terminal revision conflicts', async () => {
    const state = fixture();
    state.repository.reconcileGameConversationMembership.mockResolvedValueOnce({
      outcome: 'revision_conflict',
    });
    await registerGameMessagingMembershipConsumer({
      channel: state.channel as never,
      repository: state.repository as never,
      logger: state.logger as never,
    });
    const delivery = message();
    state.handlers[0]?.(delivery as never);
    await vi.waitFor(() => expect(state.channel.nack).toHaveBeenCalledWith(delivery, false, false));
    expect(state.channel.ack).not.toHaveBeenCalled();
  });

  it('is registered unconditionally by worker main', async () => {
    const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(source).toContain('await registerGameMessagingMembershipConsumer({');
    expect(source).not.toMatch(
      /if\s*\([^)]*\)\s*{\s*await registerGameMessagingMembershipConsumer/,
    );
  });
});
