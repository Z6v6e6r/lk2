import {
  COMMUNITY_REALTIME_EVENT_TYPES,
  communityRealtimeEventHintSchema,
} from '@phub/communities';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';

import type { CommunityRealtimeFanoutTarget } from './app.js';
import type { RealtimeMetricRecorder } from './operational-metrics.js';

interface Envelope {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly tenantId?: unknown;
  readonly occurredAt?: unknown;
  readonly correlationId?: unknown;
  readonly payload?: unknown;
}

const SAFE_LOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeLogId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_LOG_ID.test(value) ? value : undefined;
}

function decode(message: ConsumeMessage) {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(message.content.toString('utf8')) as Envelope;
  } catch {
    return undefined;
  }
  if (!envelope.payload || typeof envelope.payload !== 'object') return undefined;
  const payload = envelope.payload as Record<string, unknown>;
  const parsed = communityRealtimeEventHintSchema.safeParse({
    tenantId: envelope.tenantId,
    communityId: payload.communityId,
    sequence: payload.sequence,
    eventType: envelope.type,
    targetType: payload.targetType,
    targetId: payload.targetId,
    targetRevision: payload.revision,
    targetStatus: payload.status ?? null,
    occurredAt: envelope.occurredAt,
  });
  if (!parsed.success) return undefined;
  return {
    event: parsed.data,
    messageId: safeLogId(message.properties.messageId) ?? safeLogId(envelope.id),
    correlationId: safeLogId(message.properties.correlationId) ?? safeLogId(envelope.correlationId),
  };
}

async function handleMessage(options: {
  readonly channel: Channel;
  readonly target: CommunityRealtimeFanoutTarget;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
  readonly metrics?: RealtimeMetricRecorder;
}): Promise<void> {
  const decoded = decode(options.message);
  if (!decoded) {
    options.metrics?.recordCommunityFanoutHint('invalid');
    options.logger.warn(
      {
        messageId: safeLogId(options.message.properties.messageId),
        correlationId: safeLogId(options.message.properties.correlationId),
      },
      'invalid community realtime hint dropped',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  const { event, messageId, correlationId } = decoded;
  try {
    await options.target.publishCommunityEvent(event);
    options.metrics?.recordCommunityFanoutHint('accepted');
    options.channel.ack(options.message);
  } catch (error) {
    // PostgreSQL recovery is authoritative. Avoid an unbounded broker redelivery loop.
    options.metrics?.recordCommunityFanoutHint('fanout_failed');
    options.metrics?.recordCommunityFanoutFailure();
    options.logger.error(
      {
        error,
        messageId,
        correlationId,
        tenantId: event.tenantId,
        communityId: event.communityId,
        sequence: event.sequence,
      },
      'community realtime hint fanout failed; clients must recover over HTTP',
    );
    options.channel.ack(options.message);
  }
}

export async function registerCommunityEventConsumer(options: {
  readonly channel: Channel;
  readonly target: CommunityRealtimeFanoutTarget;
  readonly logger: Logger;
  readonly metrics?: RealtimeMetricRecorder;
  readonly onConsumerFailure: (reason: string) => void;
}): Promise<string> {
  const queue = await options.channel.assertQueue('', {
    durable: false,
    exclusive: true,
    autoDelete: true,
    arguments: { 'x-max-length': 10_000, 'x-overflow': 'drop-head' },
  });
  for (const eventType of COMMUNITY_REALTIME_EVENT_TYPES) {
    await options.channel.bindQueue(queue.queue, 'phub.events', eventType);
  }
  await options.channel.prefetch(100);
  const consumer = await options.channel.consume(
    queue.queue,
    (message) => {
      if (!message) {
        options.onConsumerFailure('community_consumer_cancelled');
        return;
      }
      void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
