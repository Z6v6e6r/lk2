import type { CommunityMemberCountProjectionRepository } from '@phub/database';
import { COMMUNITY_MEMBER_COUNT_EVENT_TYPES } from '@phub/database';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { z } from 'zod';

export const COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE = 'phub.community-member-count-projector.v1';

const uuid = z.string().uuid();
const envelopeSchema = z
  .object({
    id: uuid,
    type: z.enum(COMMUNITY_MEMBER_COUNT_EVENT_TYPES),
    tenantId: uuid,
    aggregateId: uuid,
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();

function decodeEvent(message: ConsumeMessage) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(message.content.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  const envelope = envelopeSchema.safeParse(decoded);
  if (!envelope.success) return undefined;
  const communityId = uuid.safeParse(envelope.data.payload.communityId);
  const userId = uuid.safeParse(
    envelope.data.type === 'community.created.v1'
      ? envelope.data.payload.ownerUserId
      : envelope.data.payload.userId,
  );
  if (!communityId.success || !userId.success) return undefined;
  return {
    tenantId: envelope.data.tenantId,
    eventId: envelope.data.id,
    eventType: envelope.data.type,
    communityId: communityId.data,
    userId: userId.data,
  };
}

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: Pick<CommunityMemberCountProjectionRepository, 'projectEvent'>;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  const event = decodeEvent(options.message);
  if (!event) {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid community member-count event sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  try {
    const result = await options.repository.projectEvent(event);
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        tenantId: event.tenantId,
        communityId: event.communityId,
        result,
      },
      'community member count projected',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: event.eventId, tenantId: event.tenantId },
      'community member-count projection failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerCommunityMemberCountProjectorConsumer(options: {
  readonly channel: Channel;
  readonly repository: Pick<CommunityMemberCountProjectionRepository, 'projectEvent'>;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  for (const eventType of COMMUNITY_MEMBER_COUNT_EVENT_TYPES) {
    await options.channel.bindQueue(
      COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE,
      'phub.events',
      eventType,
    );
  }
  await options.channel.prefetch(20);
  const consumer = await options.channel.consume(
    COMMUNITY_MEMBER_COUNT_PROJECTOR_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
