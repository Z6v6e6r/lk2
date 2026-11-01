import type { createQuarterStationFactRepository } from '../../../packages/database/src/game-quarter-create-repository.js';
import { z } from 'zod';
import type { createTrainingStationFactRepository } from '../../../packages/database/src/training-registration-repository.js';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { gameDomainEventSchema } from '@phub/games';
import type {
  StationMembershipClient,
  StationMembershipSigner,
} from '@phub/subscription-runtime-adapter';
import type { createStationMembershipRepository } from '../../../packages/database/src/station-membership-repository.js';

const trainingEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal('training.registration.confirmed.v1'),
    tenantId: z.string().uuid(),
    aggregateId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    correlationId: z.string().min(1),
    payload: z
      .object({
        operationId: z.string().uuid(),
        trainingId: z.string().uuid(),
        userId: z.string().uuid(),
        status: z.literal('CONFIRMED'),
      })
      .strict(),
  })
  .strict()
  .refine((e) => e.aggregateId === e.payload.trainingId);

const quarterEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal('game.quarter-create.organizer-confirmed.v1'),
    tenantId: z.string().uuid(),
    aggregateId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    correlationId: z.string().min(1),
    payload: z
      .object({
        operationId: z.string().uuid(),
        draftId: z.string().uuid(),
        userId: z.string().uuid(),
        generationId: z.string().uuid(),
        status: z.literal('CONFIRMED'),
      })
      .strict(),
  })
  .strict()
  .refine((e) => e.aggregateId === e.payload.operationId);

export const STATION_MEMBERSHIP_QUEUE = 'phub.station-membership-confirmed.v1';
interface Options {
  channel: Channel;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  repository: Pick<ReturnType<typeof createStationMembershipRepository>, 'loadConfirmedFact'>;
  quarterRepository?: ReturnType<typeof createQuarterStationFactRepository>;
  trainingRepository?: ReturnType<typeof createTrainingStationFactRepository>;
  signer: Pick<StationMembershipSigner, 'issue'>;
  client: Pick<StationMembershipClient, 'confirm'>;
}
export async function handleStationMembershipMessage(
  options: Options,
  message: ConsumeMessage,
): Promise<void> {
  let decoded: unknown;
  try {
    if (message.content.byteLength > 65536) throw new Error('too large');
    decoded = JSON.parse(message.content.toString('utf8')) as unknown;
  } catch {
    options.channel.nack(message, false, false);
    options.logger.warn({ outcome: 'invalid_json' }, 'station membership event rejected');
    return;
  }
  const parsed = gameDomainEventSchema.safeParse(decoded),
    training = trainingEventSchema.safeParse(decoded),
    quarter = quarterEventSchema.safeParse(decoded);
  if (!(
    (parsed.success &&
      parsed.data.type === 'game.participation.confirmed.v1' &&
      message.properties.messageId === parsed.data.id) ||
    (training.success && message.properties.messageId === training.data.id) ||
    (quarter.success && message.properties.messageId === quarter.data.id)
  )) {
    options.channel.nack(message, false, false);
    options.logger.warn({ outcome: 'invalid_event' }, 'station membership event rejected');
    return;
  }
  try {
    const fact = quarter.success
      ? await (() => {
          if (!options.quarterRepository) throw new Error('QUARTER_STATION_REPOSITORY_UNAVAILABLE');
          const e = quarter.data;
          return options.quarterRepository.loadQuarterConfirmedFact({
            tenantId: e.tenantId,
            eventId: e.id,
            operationId: e.aggregateId,
            draftId: e.payload.draftId,
            userId: e.payload.userId,
            generationId: e.payload.generationId,
          });
        })()
      : training.success
        ? await (() => {
            if (!options.trainingRepository)
              throw new Error('TRAINING_STATION_REPOSITORY_UNAVAILABLE');
            const event = training.data;
            return options.trainingRepository.loadTrainingConfirmedFact({
              tenantId: event.tenantId,
              eventId: event.id,
              trainingId: event.aggregateId,
              userId: event.payload.userId,
              operationId: event.payload.operationId,
            });
          })()
        : await (() => {
            if (!parsed.success || parsed.data.type !== 'game.participation.confirmed.v1')
              throw new Error('invalid event');
            const event = parsed.data;
            return options.repository.loadConfirmedFact({
              tenantId: event.tenantId,
              eventId: event.id,
              gameId: event.aggregateId,
              userId: event.payload.userId,
              participationId: event.payload.participationId,
            });
          })();
    if (!fact) {
      options.channel.ack(message);
      options.logger.info({ outcome: 'no_adopted_fact' }, 'station membership delivery');
      return;
    }
    const delegation = options.signer.issue({
      mode: 'confirmation',
      caller: 'lk2-worker',
      actor: fact.actor,
      request: fact.request,
      correlationId: fact.correlationId,
    });
    const result = await options.client.confirm(fact.request, {
      delegation,
      correlationId: fact.correlationId,
    });
    options.channel.ack(message);
    options.logger.info(
      { outcome: result.outcome, reason: result.reason },
      'station membership delivery',
    );
  } catch {
    // Quorum delivery limit bounds retries. A redelivery reloads the same immutable original fact;
    // it neither regenerates admission nor issues a provider/user credential or another booking.
    options.channel.reject(message, true);
    options.logger.error({ outcome: 'retry' }, 'station membership delivery unavailable');
  }
}
export async function registerStationMembershipConsumer(options: Options): Promise<string> {
  await options.channel.assertQueue(STATION_MEMBERSHIP_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    STATION_MEMBERSHIP_QUEUE,
    'phub.events',
    'game.participation.confirmed.v1',
  );
  await options.channel.bindQueue(
    STATION_MEMBERSHIP_QUEUE,
    'phub.events',
    'training.registration.confirmed.v1',
  );
  await options.channel.bindQueue(
    STATION_MEMBERSHIP_QUEUE,
    'phub.events',
    'game.quarter-create.organizer-confirmed.v1',
  );
  await options.channel.prefetch(10);
  const consumer = await options.channel.consume(
    STATION_MEMBERSHIP_QUEUE,
    (message) => {
      if (message) void handleStationMembershipMessage(options, message);
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
