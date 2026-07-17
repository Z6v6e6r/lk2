import { locationProfileChangedEventSchema } from '@phub/locations';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { fanOutLocationHomeComponent } from './location-home-projector.js';

export const LOCATION_HOME_PROJECTOR_QUEUE = 'phub.location-home-fanout.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid location event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  const parsed = locationProfileChangedEventSchema.safeParse(decoded);
  if (!parsed.success) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
      'invalid location event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  try {
    const result = await fanOutLocationHomeComponent({ pool: options.pool, event: parsed.data });
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: parsed.data.id,
        tenantId: parsed.data.tenantId,
        componentRevision: parsed.data.payload.componentRevision,
        ...result,
      },
      'location Home fan-out processed',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: parsed.data.id, tenantId: parsed.data.tenantId },
      'location Home fan-out failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerLocationHomeProjectorConsumer(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(LOCATION_HOME_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    LOCATION_HOME_PROJECTOR_QUEUE,
    'phub.events',
    'locations.profile.changed.v1',
  );
  await options.channel.prefetch(1);
  const consumer = await options.channel.consume(
    LOCATION_HOME_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
