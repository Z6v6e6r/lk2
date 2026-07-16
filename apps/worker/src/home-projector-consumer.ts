import type { Channel, ConsumeMessage } from 'amqplib';
import { HOME_PROJECTION_COMPONENT_EVENT, homeProjectionEventSchema } from '@phub/home-projection';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { applyHomeProjectionEvent } from './home-projector.js';

export const HOME_PROJECTOR_QUEUE = 'phub.home-projector.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly ttlSeconds: number;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid Home projection event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  const parsed = homeProjectionEventSchema.safeParse(decoded);
  if (!parsed.success) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
      'invalid Home projection event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  try {
    const result = await applyHomeProjectionEvent({
      pool: options.pool,
      event: parsed.data,
      ttlSeconds: options.ttlSeconds,
    });
    if (result.outcome === 'revision_conflict') {
      options.logger.error(
        {
          eventId: parsed.data.id,
          tenantId: parsed.data.tenantId,
          userId: parsed.data.payload.userId,
          component: result.component,
        },
        'Home component revision conflict sent to dead letter',
      );
      options.channel.nack(options.message, false, false);
      return;
    }
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: parsed.data.id,
        tenantId: parsed.data.tenantId,
        userId: parsed.data.payload.userId,
        component: parsed.data.payload.component,
        outcome: result.outcome,
        ...(result.outcome === 'projected' ? { snapshotVersion: result.snapshotVersion } : {}),
      },
      'Home projection event processed',
    );
  } catch (error) {
    options.logger.error(
      {
        err: error,
        eventId: parsed.data.id,
        tenantId: parsed.data.tenantId,
        component: parsed.data.payload.component,
      },
      'Home projection event failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerHomeProjectorConsumer(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly ttlSeconds: number;
}): Promise<string> {
  await options.channel.assertQueue(HOME_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    HOME_PROJECTOR_QUEUE,
    'phub.events',
    HOME_PROJECTION_COMPONENT_EVENT,
  );
  await options.channel.prefetch(10);
  const consumer = await options.channel.consume(
    HOME_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
