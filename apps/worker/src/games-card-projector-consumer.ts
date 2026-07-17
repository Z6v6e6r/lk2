import type { GameRepository } from '@phub/database';
import { gameDomainEventSchema } from '@phub/games';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

export const GAMES_CARD_PROJECTOR_QUEUE = 'phub.games-card-projector.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameRepository, 'projectCardEvent'>;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid Games event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  const parsed = gameDomainEventSchema.safeParse(decoded);
  if (!parsed.success) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
      'invalid Games event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  try {
    const result = await options.repository.projectCardEvent({
      tenantId: parsed.data.tenantId,
      eventId: parsed.data.id,
      gameId: parsed.data.aggregateId,
    });
    if (result === 'dependency_missing') {
      throw new Error('GAME_CARD_PROJECTION_DEPENDENCY_MISSING');
    }
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        tenantId: parsed.data.tenantId,
        gameId: parsed.data.aggregateId,
        result,
      },
      'Games card projection event processed',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: parsed.data.id, tenantId: parsed.data.tenantId },
      'Games card projection failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerGamesCardProjectorConsumer(options: {
  readonly channel: Channel;
  readonly repository: Pick<GameRepository, 'projectCardEvent'>;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(GAMES_CARD_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(GAMES_CARD_PROJECTOR_QUEUE, 'phub.events', 'game.#');
  await options.channel.prefetch(1);
  const consumer = await options.channel.consume(
    GAMES_CARD_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
