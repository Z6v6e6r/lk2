import type { GameMessagingMembershipSourceEventType, MessagingRepository } from '@phub/database';
import { GAME_DOMAIN_EVENT_TYPES, consumersForGameEvent, gameDomainEventSchema } from '@phub/games';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

export const GAME_MESSAGING_MEMBERSHIP_QUEUE = 'phub.game-messaging-membership.v1';
export const GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS = GAME_DOMAIN_EVENT_TYPES.filter((type) =>
  consumersForGameEvent(type).includes('messaging-membership'),
) as readonly GameMessagingMembershipSourceEventType[];

const routingKeys = new Set<string>(GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS);

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: MessagingRepository;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid GAME messaging membership event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  const parsed = gameDomainEventSchema.safeParse(decoded);
  if (
    !parsed.success ||
    !routingKeys.has(parsed.data.type) ||
    options.message.properties.messageId !== parsed.data.id
  ) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        ...(parsed.success
          ? { eventId: parsed.data.id, eventType: parsed.data.type }
          : {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                code: issue.code,
              })),
            }),
      },
      'invalid GAME messaging membership event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }

  try {
    const result = await options.repository.reconcileGameConversationMembership({
      tenantId: parsed.data.tenantId,
      gameId: parsed.data.aggregateId,
      sourceEventId: parsed.data.id,
      sourceEventType: parsed.data.type as GameMessagingMembershipSourceEventType,
      sourceAggregateRevision: parsed.data.payload.aggregateRevision,
      correlationId: parsed.data.correlationId,
      occurredAt: parsed.data.occurredAt,
    });
    if (result.outcome === 'revision_conflict') {
      options.logger.error(
        {
          eventId: parsed.data.id,
          eventType: parsed.data.type,
          tenantId: parsed.data.tenantId,
        },
        'GAME messaging membership revision conflict sent to dead letter',
      );
      options.channel.nack(options.message, false, false);
      return;
    }
    options.channel.ack(options.message);
    const resultSummary =
      result.outcome === 'applied'
        ? {
            outcome: result.outcome,
            conversationClosed: result.conversationClosed,
            activatedMemberCount: result.activatedUserIds.length,
            leftMemberCount: result.leftUserIds.length,
          }
        : result;
    options.logger.info(
      {
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        tenantId: parsed.data.tenantId,
        result: resultSummary,
      },
      'GAME messaging membership reconciled',
    );
  } catch (error) {
    options.logger.error(
      {
        err: error,
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        tenantId: parsed.data.tenantId,
      },
      'GAME messaging membership reconciliation failed and will be retried',
    );
    // RabbitMQ 4.3+ increments a quorum queue's delivery count for basic.reject.
    options.channel.reject(options.message, true);
  }
}

export async function registerGameMessagingMembershipConsumer(options: {
  readonly channel: Channel;
  readonly repository: MessagingRepository;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  for (const routingKey of GAME_MESSAGING_MEMBERSHIP_ROUTING_KEYS) {
    await options.channel.bindQueue(GAME_MESSAGING_MEMBERSHIP_QUEUE, 'phub.events', routingKey);
  }
  await options.channel.prefetch(10);
  const consumer = await options.channel.consume(
    GAME_MESSAGING_MEMBERSHIP_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
