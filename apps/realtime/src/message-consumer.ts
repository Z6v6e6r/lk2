import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

import type { RealtimeMessageCreatedEvent } from './app.js';

const EVENT_EXCHANGE = 'phub.events';
const MESSAGE_CREATED_EVENT = 'messaging.message.created.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OutboxEnvelope {
  readonly type: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  };
}

function parseEvent(message: ConsumeMessage): RealtimeMessageCreatedEvent {
  const parsed = JSON.parse(message.content.toString('utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('type' in parsed) ||
    !('tenantId' in parsed) ||
    !('occurredAt' in parsed) ||
    !('correlationId' in parsed) ||
    !('payload' in parsed)
  ) {
    throw new Error('REALTIME_EVENT_INVALID');
  }
  const envelope = parsed as OutboxEnvelope;
  const payload = envelope.payload;
  if (
    envelope.type !== MESSAGE_CREATED_EVENT ||
    !UUID_PATTERN.test(envelope.tenantId) ||
    typeof envelope.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
    typeof envelope.correlationId !== 'string' ||
    typeof payload !== 'object' ||
    payload === null ||
    !UUID_PATTERN.test(payload.conversationId) ||
    !UUID_PATTERN.test(payload.messageId) ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1
  ) {
    throw new Error('REALTIME_EVENT_INVALID');
  }
  return {
    tenantId: envelope.tenantId,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    sequence: payload.sequence,
    correlationId: envelope.correlationId,
    occurredAt: envelope.occurredAt,
  };
}

export async function registerMessagingRealtimeConsumer(options: {
  readonly channel: Channel;
  readonly logger: Logger;
  readonly publish: (event: RealtimeMessageCreatedEvent) => Promise<number>;
}): Promise<{ readonly queueName: string; readonly consumerTag: string }> {
  await options.channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
  const queue = await options.channel.assertQueue('', {
    exclusive: true,
    autoDelete: true,
  });
  await options.channel.bindQueue(queue.queue, EVENT_EXCHANGE, MESSAGE_CREATED_EVENT);
  const consumer = await options.channel.consume(
    queue.queue,
    (message) => {
      if (!message) return;
      void (async () => {
        try {
          const event = parseEvent(message);
          const delivered = await options.publish(event);
          options.logger.debug(
            {
              tenantId: event.tenantId,
              conversationId: event.conversationId,
              messageId: event.messageId,
              sequence: event.sequence,
              delivered,
            },
            'realtime message event projected',
          );
        } catch (error) {
          options.logger.error({ error }, 'realtime message event rejected');
        } finally {
          options.channel.ack(message);
        }
      })();
    },
    { noAck: false },
  );
  return { queueName: queue.queue, consumerTag: consumer.consumerTag };
}
