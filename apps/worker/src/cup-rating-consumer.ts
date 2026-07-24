import type { GameResultProjectionRepository } from '@phub/database';
import { gameDomainEventSchema } from '@phub/games';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

import type { CupRatingClient } from './cup-rating-client.js';

export const CUP_RATING_CONSUMER_QUEUE = 'phub.cup-rating-consumer.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameResultProjectionRepository, 'loadConfirmedResult'>;
  readonly client: Pick<CupRatingClient, 'applyConfirmedResult'>;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.channel.nack(options.message, false, false);
    return;
  }
  const parsed = gameDomainEventSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.type !== 'game.result.confirmed.v1') {
    options.channel.nack(options.message, false, false);
    return;
  }
  try {
    const result = await options.repository.loadConfirmedResult({
      tenantId: parsed.data.tenantId,
      resultId: parsed.data.payload.resultId,
    });
    if (!result) throw new Error('CUP_RATING_RESULT_SOURCE_MISSING');
    const outcome = await options.client.applyConfirmedResult(result, parsed.data.correlationId);
    options.channel.ack(options.message);
    options.logger.info(
      { resultId: result.resultId, gameId: result.gameId, outcome },
      'confirmed game result delivered to CUP rating ledger',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: parsed.data.id, resultId: parsed.data.payload.resultId },
      'CUP rating delivery failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerCupRatingConsumer(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameResultProjectionRepository, 'loadConfirmedResult'>;
  readonly client: Pick<CupRatingClient, 'applyConfirmedResult'>;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(CUP_RATING_CONSUMER_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 8,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    CUP_RATING_CONSUMER_QUEUE,
    'phub.events',
    'game.result.confirmed.v1',
  );
  const consumer = await options.channel.consume(
    CUP_RATING_CONSUMER_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
