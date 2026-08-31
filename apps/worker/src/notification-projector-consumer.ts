import {
  BOOKING_NOTIFICATION_EVENT_TYPES,
  GAME_NOTIFICATION_EVENT_TYPES,
  notificationSourceEventSchema,
} from '@phub/notifications';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { applyNotificationSourceEvent } from './notification-projector.js';

export const NOTIFICATION_PROJECTOR_QUEUE = 'phub.notification-intent-projector.v1';
export const GAME_NOTIFICATION_PROJECTOR_QUEUE = 'phub.game-notification-intent-projector.v1';
export const NOTIFICATION_SOURCE_ROUTING_KEYS = BOOKING_NOTIFICATION_EVENT_TYPES;
export const GAME_NOTIFICATION_SOURCE_ROUTING_KEYS = GAME_NOTIFICATION_EVENT_TYPES;

async function handleMessage(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
  readonly webPush?: {
    readonly appId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
  };
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid notification source event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  const parsed = notificationSourceEventSchema.safeParse(decoded);
  if (!parsed.success) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
      'invalid notification source event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  try {
    const result = await applyNotificationSourceEvent({
      pool: options.pool,
      event: parsed.data,
      ...(options.webPush ? { webPush: options.webPush } : {}),
    });
    if (result.outcome === 'revision_conflict') {
      options.logger.error(
        {
          eventId: parsed.data.id,
          eventType: parsed.data.type,
          tenantId: parsed.data.tenantId,
        },
        'notification source revision conflict sent to dead letter',
      );
      options.channel.nack(options.message, false, false);
      return;
    }
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        tenantId: parsed.data.tenantId,
        result,
      },
      'notification source event processed',
    );
  } catch (error) {
    options.logger.error(
      {
        err: error,
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        tenantId: parsed.data.tenantId,
      },
      'notification source event failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerNotificationProjectorConsumer(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly webPush?: {
    readonly appId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
  };
}): Promise<string> {
  const queueOptions = {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  } as const;
  await options.channel.assertQueue(NOTIFICATION_PROJECTOR_QUEUE, queueOptions);
  // Preserve the legacy booking queue for mixed-version workers. GAME events use a new queue so
  // an older worker can never consume a contract or selector it does not understand.
  for (const routingKey of NOTIFICATION_SOURCE_ROUTING_KEYS) {
    await options.channel.bindQueue(NOTIFICATION_PROJECTOR_QUEUE, 'phub.events', routingKey);
  }
  await options.channel.assertQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE, queueOptions);
  for (const routingKey of GAME_NOTIFICATION_SOURCE_ROUTING_KEYS) {
    await options.channel.bindQueue(GAME_NOTIFICATION_PROJECTOR_QUEUE, 'phub.events', routingKey);
  }
  // Establish a complete route for every GAME event before removing the legacy wildcard. RabbitMQ
  // publisher confirms do not reject unroutable messages, so the opposite order creates a loss gap.
  await options.channel.unbindQueue(NOTIFICATION_PROJECTOR_QUEUE, 'phub.events', '#');
  await options.channel.prefetch(10);
  const bookingConsumer = await options.channel.consume(
    NOTIFICATION_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  await options.channel.consume(
    GAME_NOTIFICATION_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return bookingConsumer.consumerTag;
}
