import { notificationSourceEventSchema } from '@phub/notifications';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { applyNotificationSourceEvent } from './notification-projector.js';

export const NOTIFICATION_PROJECTOR_QUEUE = 'phub.notification-intent-projector.v1';

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
  await options.channel.assertQueue(NOTIFICATION_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(NOTIFICATION_PROJECTOR_QUEUE, 'phub.events', '#');
  await options.channel.prefetch(10);
  const consumer = await options.channel.consume(
    NOTIFICATION_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
