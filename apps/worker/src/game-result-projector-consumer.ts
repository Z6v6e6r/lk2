import type { GameResultProjectionRepository } from '@phub/database';
import { gameDomainEventSchema } from '@phub/games';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

export const GAME_RESULT_PROJECTOR_QUEUE = 'phub.game-result-projector.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameResultProjectionRepository, 'projectConfirmedResultEvent'>;
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
    const outcome = await options.repository.projectConfirmedResultEvent({
      tenantId: parsed.data.tenantId,
      eventId: parsed.data.id,
      resultId: parsed.data.payload.resultId,
    });
    if (outcome === 'result_not_found') throw new Error('GAME_RESULT_PROJECTION_SOURCE_MISSING');
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: parsed.data.id,
        gameId: parsed.data.payload.gameId,
        resultId: parsed.data.payload.resultId,
        outcome,
      },
      'confirmed game result projected to player history and set facts',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: parsed.data.id, resultId: parsed.data.payload.resultId },
      'game result projection failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerGameResultProjectorConsumer(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameResultProjectionRepository, 'projectConfirmedResultEvent'>;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(GAME_RESULT_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    GAME_RESULT_PROJECTOR_QUEUE,
    'phub.events',
    'game.result.confirmed.v1',
  );
  const consumer = await options.channel.consume(
    GAME_RESULT_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
