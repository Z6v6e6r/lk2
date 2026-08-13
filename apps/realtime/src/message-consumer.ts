import { createHash } from 'node:crypto';

import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

import type { RealtimeMessageCreatedEvent } from './app.js';

const EVENT_EXCHANGE = 'phub.events';
const QUARANTINE_QUEUE = 'phub.realtime.messaging.quarantine.v1';
const MESSAGE_CREATED_EVENT = 'messaging.message.created.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class InvalidRealtimeEventError extends Error {
  public constructor() {
    super('REALTIME_EVENT_INVALID');
  }
}

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

export function parseRealtimeEvent(message: ConsumeMessage): RealtimeMessageCreatedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content.toString('utf8')) as unknown;
  } catch {
    throw new InvalidRealtimeEventError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('type' in parsed) ||
    !('tenantId' in parsed) ||
    !('occurredAt' in parsed) ||
    !('correlationId' in parsed) ||
    !('payload' in parsed)
  ) {
    throw new InvalidRealtimeEventError();
  }
  const envelope = parsed as OutboxEnvelope;
  const payload = envelope.payload;
  if (
    envelope.type !== MESSAGE_CREATED_EVENT ||
    typeof envelope.tenantId !== 'string' ||
    !UUID_PATTERN.test(envelope.tenantId) ||
    typeof envelope.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
    typeof envelope.correlationId !== 'string' ||
    !CORRELATION_ID_PATTERN.test(envelope.correlationId) ||
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.conversationId !== 'string' ||
    !UUID_PATTERN.test(payload.conversationId) ||
    typeof payload.messageId !== 'string' ||
    !UUID_PATTERN.test(payload.messageId) ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1
  ) {
    throw new InvalidRealtimeEventError();
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
  readonly channel: ConfirmChannel;
  readonly logger: Logger;
  readonly publish: (event: RealtimeMessageCreatedEvent) => Promise<number>;
  readonly onConsumerFailure: (reason: 'cancelled' | 'projection_failed') => void;
}): Promise<{ readonly queueName: string; readonly consumerTag: string }> {
  await options.channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
  await options.channel.assertQueue(QUARANTINE_QUEUE, { durable: true });
  const queue = await options.channel.assertQueue('', { exclusive: true, autoDelete: true });
  await options.channel.bindQueue(queue.queue, EVENT_EXCHANGE, MESSAGE_CREATED_EVENT);
  await options.channel.prefetch(1);

  const consumer = await options.channel.consume(
    queue.queue,
    (message) => {
      if (!message) {
        options.onConsumerFailure('cancelled');
        return;
      }
      void (async () => {
        try {
          const event = parseRealtimeEvent(message);
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
          options.channel.ack(message);
        } catch (error) {
          if (error instanceof InvalidRealtimeEventError) {
            const quarantineRecord = {
              reason: error.message,
              routingKey: message.fields.routingKey,
              contentSha256: createHash('sha256').update(message.content).digest('hex'),
              receivedAt: new Date().toISOString(),
            };
            try {
              options.channel.sendToQueue(
                QUARANTINE_QUEUE,
                Buffer.from(JSON.stringify(quarantineRecord)),
                { persistent: true, contentType: 'application/json' },
              );
              await options.channel.waitForConfirms();
              options.logger.warn(quarantineRecord, 'invalid realtime event sent to quarantine');
              options.channel.ack(message);
            } catch (quarantineError) {
              options.logger.error(
                {
                  err: quarantineError,
                  routingKey: quarantineRecord.routingKey,
                  contentSha256: quarantineRecord.contentSha256,
                },
                'realtime quarantine publish failed; channel will reconnect',
              );
              options.onConsumerFailure('projection_failed');
            }
            return;
          }
          options.logger.error(
            { err: error },
            'realtime projection failed; channel will reconnect',
          );
          options.onConsumerFailure('projection_failed');
        }
      })();
    },
    { noAck: false },
  );
  return { queueName: queue.queue, consumerTag: consumer.consumerTag };
}
