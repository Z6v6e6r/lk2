import { randomUUID } from 'node:crypto';

import { connect, type Channel, type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  EVENT_EXCHANGE,
  registerCoreBrokerTopology,
} from './broker-topology.js';
import {
  GAME_NOTIFICATION_PROJECTOR_QUEUE,
  registerNotificationProjectorConsumer,
} from './notification-projector-consumer.js';

const connectionString = process.env.NOTIFICATION_RESILIENCE_TEST_RABBITMQ_URL;
const describeRabbit = connectionString ? describe : describe.skip;
const deadlineMs = 15_000;

async function waitForMessageCount(
  channel: Channel,
  queue: string,
  minimum: number,
  label: string,
): Promise<number> {
  const expiresAt = Date.now() + deadlineMs;
  while (Date.now() < expiresAt) {
    const state = await channel.checkQueue(queue);
    if (state.messageCount >= minimum) return state.messageCount;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`RABBIT_TEST_TIMEOUT:${label}`);
}

function gameEvent(): Buffer {
  const gameId = randomUUID();
  const userId = randomUUID();
  return Buffer.from(
    JSON.stringify({
      id: randomUUID(),
      type: 'game.participation.confirmed.v1',
      aggregateId: gameId,
      tenantId: randomUUID(),
      occurredAt: '2026-09-01T00:00:00.000Z',
      correlationId: `rabbit-resilience-${randomUUID()}`,
      payload: {
        gameId,
        aggregateRevision: '1',
        causationId: randomUUID(),
        actorUserId: userId,
        userId,
        participationId: randomUUID(),
      },
    }),
  );
}

function requireMessage(message: GetMessage | false): asserts message is GetMessage {
  expect(message).not.toBe(false);
  if (!message) throw new Error('RABBIT_TEST_MESSAGE_REQUIRED');
}

describeRabbit('notification RabbitMQ physical resilience', () => {
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    if (!connectionString) throw new Error('NOTIFICATION_RESILIENCE_TEST_RABBITMQ_URL_REQUIRED');
    const url = new URL(connectionString);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('NOTIFICATION_RESILIENCE_RABBITMQ_MUST_BE_DISPOSABLE_LOOPBACK');
    }
    connection = await connect(connectionString);
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    if (channel) await channel.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
  }, 20_000);

  it('recreates required queues and provisions the exact topology twice', async () => {
    await registerCoreBrokerTopology(channel);
    await channel.deleteQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE);
    const pool = {
      connect: vi.fn().mockRejectedValue(new Error('SYNTHETIC_DB_UNAVAILABLE')),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await registerNotificationProjectorConsumer({
      channel,
      pool: pool as never,
      logger: logger as never,
    });
    await registerCoreBrokerTopology(channel);
    await registerNotificationProjectorConsumer({
      channel,
      pool: pool as never,
      logger: logger as never,
    });

    const gameQueue = await channel.checkQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE);
    expect(gameQueue.consumerCount).toBe(2);
    const deadLetter = await channel.checkQueue(DEAD_LETTER_QUEUE);
    expect(deadLetter.consumerCount).toBe(0);

    channel.publish(EVENT_EXCHANGE, 'game.unknown.v1', gameEvent(), {
      persistent: true,
      messageId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(channel.checkQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE)).resolves.toMatchObject({
      messageCount: 0,
    });
    await channel.close();
    await connection.close();
    connection = await connect(connectionString!);
    channel = await connection.createChannel();
    await registerCoreBrokerTopology(channel);
  }, 20_000);

  it('rejects wrong queue arguments and wrong DLX instead of silently accepting drift', async () => {
    const queue = `notification-topology-mismatch-${randomUUID()}`;
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      },
    });
    const sacrificial = await connection.createChannel();
    sacrificial.on('error', () => undefined);
    await expect(
      sacrificial.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': 5,
          'x-dead-letter-exchange': `${DEAD_LETTER_EXCHANGE}.wrong`,
        },
      }),
    ).rejects.toThrow(/PRECONDITION_FAILED|inequivalent arg/i);
    await channel.deleteQueue(queue);
  }, 20_000);

  it('redelivers an unacked delivery after worker loss', async () => {
    const queue = `notification-crash-replay-${randomUUID()}`;
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      },
    });
    await channel.bindQueue(queue, EVENT_EXCHANGE, 'game.crash-replay.v1');
    channel.publish(EVENT_EXCHANGE, 'game.crash-replay.v1', gameEvent(), {
      persistent: true,
      messageId: randomUUID(),
    });
    await waitForMessageCount(channel, queue, 1, 'initial-crash-message');

    const crashedChannel = await connection.createChannel();
    const first = await crashedChannel.get(queue, { noAck: false });
    requireMessage(first);
    await crashedChannel.close();

    await waitForMessageCount(channel, queue, 1, 'redelivery-after-channel-close');
    const replayed = await channel.get(queue, { noAck: false });
    requireMessage(replayed);
    expect(replayed.fields.redelivered).toBe(true);
    channel.ack(replayed);
    await channel.deleteQueue(queue);
  }, 20_000);

  it('bounds retry into DLQ and supports an explicit replay fixture', async () => {
    let deliveryAttempts = 0;
    await channel.purgeQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE);
    const consumer = await channel.consume(
      GAME_NOTIFICATION_PROJECTOR_QUEUE,
      (message) => {
        if (!message) return;
        deliveryAttempts += 1;
        channel.reject(message, true);
      },
      { noAck: false },
    );
    try {
      await channel.purgeQueue(DEAD_LETTER_QUEUE);
      const before = (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount;
      const payload = gameEvent();
      channel.publish(EVENT_EXCHANGE, 'game.participation.confirmed.v1', payload, {
        persistent: true,
        messageId: randomUUID(),
      });
      await waitForMessageCount(channel, DEAD_LETTER_QUEUE, before + 1, 'bounded-retry-dlq');
      expect(deliveryAttempts).toBeGreaterThanOrEqual(5);

      const dead = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
      requireMessage(dead);
      const replayQueue = (
        await channel.assertQueue('', { durable: false, exclusive: true, autoDelete: true })
      ).queue;
      await channel.bindQueue(replayQueue, EVENT_EXCHANGE, 'game.replay-fixture.v1');
      channel.ack(dead);
      channel.publish(EVENT_EXCHANGE, 'game.replay-fixture.v1', dead.content, {
        persistent: false,
        messageId: randomUUID(),
      });
      await waitForMessageCount(channel, replayQueue, 1, 'dlq-replay-fixture');
      const replayed = await channel.get(replayQueue, { noAck: true });
      requireMessage(replayed);
      expect(replayed.content).toEqual(payload);
    } finally {
      await channel.cancel(consumer.consumerTag).catch(() => undefined);
    }
  }, 30_000);
});
