import type { Channel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { ingestNotificationScenarioEvent, SCENARIO_SOURCE_KEYS } from './notification-scenarios.js';

export const NOTIFICATION_SCENARIO_QUEUE = 'phub.notification-scenarios.v1';
export async function registerNotificationScenarioConsumer(options: {
  readonly channel: Channel;
  readonly pool: Pool;
  readonly logger: Logger;
}): Promise<string> {
  const { channel } = options;
  await channel.assertQueue(NOTIFICATION_SCENARIO_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  for (const key of SCENARIO_SOURCE_KEYS)
    await channel.bindQueue(NOTIFICATION_SCENARIO_QUEUE, 'phub.events', key);
  const handle = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch {
      channel.reject(message, false);
      return;
    }
    try {
      await ingestNotificationScenarioEvent(options.pool, decoded);
      channel.ack(message);
    } catch (error) {
      // Never log the decoded body, templates or recipient endpoint. Quorum retries are bounded.
      const code = error instanceof Error ? error.message : '';
      const invalid =
        code === 'SCENARIO_EVENT_UNSUPPORTED' ||
        code === 'SCENARIO_REVISION_CONFLICT' ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === 'ZodError');
      options.logger.warn(
        {
          messageId: message.properties.messageId,
          code: invalid ? 'SCENARIO_EVENT_INVALID' : 'SCENARIO_EVENT_RETRY',
        },
        'scenario event not processed',
      );
      channel.reject(message, !invalid);
    }
  };
  const result = await channel.consume(
    NOTIFICATION_SCENARIO_QUEUE,
    (message) => {
      void handle(message);
    },
    { noAck: false },
  );
  return result.consumerTag;
}
