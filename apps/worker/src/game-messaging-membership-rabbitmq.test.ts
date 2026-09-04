import { randomUUID } from 'node:crypto';

import { connect, type Channel, type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_QUEUE,
  EVENT_EXCHANGE,
  registerCoreBrokerTopology,
} from './broker-topology.js';
import {
  GAME_MESSAGING_MEMBERSHIP_QUEUE,
  GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS,
  registerGameMessagingMembershipConsumer,
} from './game-messaging-membership-consumer.js';

const connectionString = process.env.GAME_MESSAGING_MEMBERSHIP_TEST_RABBITMQ_URL;
const describeRabbit = connectionString ? describe : describe.skip;
const deadlineMs = 20_000;

export function assertDisposableRabbit(url: string): void {
  const parsed = new URL(url);
  const vhost = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['amqp:', 'amqps:'].includes(parsed.protocol) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !vhost.endsWith('_verify')
  ) {
    throw new Error(
      'GAME_MESSAGING_MEMBERSHIP_TEST_RABBITMQ_URL must use a query-free loopback *_verify vhost',
    );
  }
}

if (connectionString) assertDisposableRabbit(connectionString);

async function waitFor(condition: () => boolean | Promise<boolean>, label: string) {
  const expiresAt = Date.now() + deadlineMs;
  while (Date.now() < expiresAt) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`RABBIT_TEST_TIMEOUT:${label}`);
}

function gameEvent(type: (typeof GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS)[number]) {
  const gameId = randomUUID();
  const userId = randomUUID();
  const base = {
    id: randomUUID(),
    type,
    aggregateId: gameId,
    tenantId: randomUUID(),
    occurredAt: '2026-09-04T10:00:00.000Z',
    correlationId: `game-membership-rabbit-${randomUUID()}`,
  };
  const payloadBase = {
    gameId,
    aggregateRevision: '2',
    causationId: randomUUID(),
    actorUserId: userId,
  };
  if (type === 'game.scheduled.v1') {
    return { ...base, payload: { ...payloadBase, organizerUserId: userId } };
  }
  if (type === 'game.cancelled.v1') {
    return {
      ...base,
      payload: {
        ...payloadBase,
        participantUserIds: [userId],
        reasonCode: 'ORGANIZER_REQUEST',
      },
    };
  }
  return {
    ...base,
    payload: { ...payloadBase, userId, participationId: randomUUID() },
  };
}

function requireMessage(message: GetMessage | false): asserts message is GetMessage {
  expect(message).not.toBe(false);
  if (!message) throw new Error('RABBIT_TEST_MESSAGE_REQUIRED');
}

describe('GAME messaging RabbitMQ verifier guard', () => {
  it('accepts only a query-free loopback disposable vhost', () => {
    expect(() =>
      assertDisposableRabbit('amqp://verify@127.0.0.1:5672/game_membership_verify'),
    ).not.toThrow();
    expect(() =>
      assertDisposableRabbit('amqp://verify@rabbit.example/game_membership_verify'),
    ).toThrow('GAME_MESSAGING_MEMBERSHIP_TEST_RABBITMQ_URL');
  });
});

describeRabbit('GAME messaging membership RabbitMQ physical resilience', () => {
  let connection: ChannelModel;
  let channel: Channel;
  let sentinelQueue: string;

  beforeAll(async () => {
    if (!connectionString) {
      throw new Error('GAME_MESSAGING_MEMBERSHIP_TEST_RABBITMQ_URL_REQUIRED');
    }
    connection = await connect(connectionString);
    channel = await connection.createChannel();
    sentinelQueue = `game-membership-fixture-${randomUUID()}`;
    const sentinel = await channel.assertQueue(sentinelQueue, {
      durable: false,
      exclusive: true,
      autoDelete: true,
    });
    if (sentinel.queue !== sentinelQueue) throw new Error('RABBIT_FIXTURE_SENTINEL_MISMATCH');
    await registerCoreBrokerTopology(channel);
  });

  afterAll(async () => {
    if (channel) await channel.deleteQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE).catch(() => undefined);
    if (channel) await channel.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
  }, 20_000);

  it('routes every exact catalog event to the registered consumer and ACKs success', async () => {
    await channel.deleteQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE).catch(() => undefined);
    const repository = {
      reconcileGameConversationMembership: vi.fn().mockResolvedValue({ outcome: 'no_op' }),
    };
    const registered = await registerGameMessagingMembershipConsumer({
      channel,
      repository: repository as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    for (const routingKey of GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS) {
      const body = gameEvent(routingKey);
      channel.publish(EVENT_EXCHANGE, routingKey, Buffer.from(JSON.stringify(body)), {
        persistent: true,
        messageId: body.id,
      });
    }
    await waitFor(
      () =>
        repository.reconcileGameConversationMembership.mock.calls.length ===
        GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS.length,
      'all-exact-routes',
    );
    await waitFor(
      async () => (await channel.checkQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE)).messageCount === 0,
      'successful-acks',
    );
    await channel.cancel(registered);
  });

  it('dead-letters poison contracts without a repository call', async () => {
    await channel.deleteQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE).catch(() => undefined);
    await channel.purgeQueue(DEAD_LETTER_QUEUE);
    const repository = { reconcileGameConversationMembership: vi.fn() };
    const registered = await registerGameMessagingMembershipConsumer({
      channel,
      repository: repository as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    channel.publish(EVENT_EXCHANGE, 'game.cancelled.v1', Buffer.from('{'), {
      persistent: true,
      messageId: randomUUID(),
    });
    await waitFor(
      async () => (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount >= 1,
      'poison-dlq',
    );
    expect(repository.reconcileGameConversationMembership).not.toHaveBeenCalled();
    const dead = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
    requireMessage(dead);
    channel.ack(dead);
    await channel.cancel(registered);
  });

  it('bounds transient retry into the DLQ through quorum delivery-limit', async () => {
    await channel.deleteQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE).catch(() => undefined);
    await channel.purgeQueue(DEAD_LETTER_QUEUE);
    const repository = {
      reconcileGameConversationMembership: vi.fn().mockRejectedValue(new Error('temporary DB')),
    };
    const registered = await registerGameMessagingMembershipConsumer({
      channel,
      repository: repository as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    const body = gameEvent('game.participation.left.v1');
    channel.publish(EVENT_EXCHANGE, body.type, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      messageId: body.id,
    });
    await waitFor(
      async () => (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount >= 1,
      'bounded-retry-dlq',
    );
    expect(repository.reconcileGameConversationMembership.mock.calls.length).toBeGreaterThanOrEqual(
      5,
    );
    const dead = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
    requireMessage(dead);
    channel.ack(dead);
    await channel.cancel(registered).catch(() => undefined);
  }, 30_000);

  it('redelivers after channel loss and accepts the idempotent no-op replay', async () => {
    await channel.deleteQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE).catch(() => undefined);
    const crashedChannel = await connection.createChannel();
    const neverSettles = new Promise(() => undefined);
    const firstRepository = {
      reconcileGameConversationMembership: vi.fn().mockReturnValue(neverSettles),
    };
    await registerGameMessagingMembershipConsumer({
      channel: crashedChannel,
      repository: firstRepository as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    const body = gameEvent('game.participation.confirmed.v1');
    channel.publish(EVENT_EXCHANGE, body.type, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      messageId: body.id,
    });
    await waitFor(
      () => firstRepository.reconcileGameConversationMembership.mock.calls.length === 1,
      'first-unacked-delivery',
    );
    await crashedChannel.close();
    const replayRepository = {
      reconcileGameConversationMembership: vi.fn().mockResolvedValue({ outcome: 'no_op' }),
    };
    const registered = await registerGameMessagingMembershipConsumer({
      channel,
      repository: replayRepository as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    await waitFor(
      () => replayRepository.reconcileGameConversationMembership.mock.calls.length === 1,
      'redelivery-after-channel-loss',
    );
    await channel.cancel(registered);
  }, 30_000);
});
