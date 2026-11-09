import type { GameResultProjectionRepository, Lk1ResultBridgeRepository } from '@phub/database';
import { gameDomainEventSchema } from '@phub/games';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

import type { Lk1ResultClient } from './lk1-result-client.js';
import { lk1ScoreFromSets } from './lk1-result-score.js';

export const LK1_RESULT_BRIDGE_QUEUE = 'phub.lk1-result-bridge.v1';

async function handleMessage(options: {
  readonly channel: Channel;
  readonly bridge: Pick<Lk1ResultBridgeRepository, 'loadHandoff'>;
  readonly repository: Pick<GameResultProjectionRepository, 'loadConfirmedResult'>;
  readonly client: Pick<Lk1ResultClient, 'importConfirmedResult'>;
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
  const { tenantId, payload, correlationId } = parsed.data;
  try {
    const handoff = await options.bridge.loadHandoff({ tenantId, resultId: payload.resultId });
    if (!handoff) throw new Error('LK1_RESULT_HANDOFF_MISSING');
    if (!handoff.lk1GameId) {
      // The game exists only in LK2, so LK1 has no record to update. This is expected, not an error.
      options.channel.ack(options.message);
      options.logger.info(
        { gameId: handoff.gameId, resultId: handoff.resultId },
        'confirmed result has no LK1 game and stays local',
      );
      return;
    }
    if (!handoff.submitterPhoneE164) {
      // Without a phone LK1 cannot attribute the result to a participant. Leave it for reconciliation
      // instead of retrying a request that can never succeed.
      options.channel.ack(options.message);
      options.logger.error(
        { gameId: handoff.gameId, resultId: handoff.resultId, outcome: 'submitter_phone_missing' },
        'confirmed result cannot reach LK1 without a mapped submitter phone',
      );
      return;
    }
    const projection = await options.repository.loadConfirmedResult({
      tenantId,
      resultId: payload.resultId,
    });
    if (!projection) throw new Error('LK1_RESULT_SOURCE_MISSING');
    const score = lk1ScoreFromSets(projection.sets);
    if (!score) {
      options.channel.ack(options.message);
      options.logger.error(
        { gameId: projection.gameId, resultId: projection.resultId, outcome: 'score_missing' },
        'confirmed result has no usable sets for the LK1 score',
      );
      return;
    }
    const outcome = await options.client.importConfirmedResult({
      handoff,
      score,
      correlationId,
    });
    options.channel.ack(options.message);
    const log =
      outcome === 'rejected'
        ? options.logger.error.bind(options.logger)
        : options.logger.info.bind(options.logger);
    log(
      {
        gameId: projection.gameId,
        resultId: projection.resultId,
        resultRevision: projection.resultRevision,
        outcome,
      },
      'confirmed game result delivered to LK1',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: parsed.data.id, resultId: payload.resultId },
      'LK1 result delivery failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerLk1ResultBridgeConsumer(options: {
  readonly channel: Channel;
  readonly bridge: Pick<Lk1ResultBridgeRepository, 'loadHandoff'>;
  readonly repository: Pick<GameResultProjectionRepository, 'loadConfirmedResult'>;
  readonly client: Pick<Lk1ResultClient, 'importConfirmedResult'>;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(LK1_RESULT_BRIDGE_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 8,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    LK1_RESULT_BRIDGE_QUEUE,
    'phub.events',
    'game.result.confirmed.v1',
  );
  const consumer = await options.channel.consume(
    LK1_RESULT_BRIDGE_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
