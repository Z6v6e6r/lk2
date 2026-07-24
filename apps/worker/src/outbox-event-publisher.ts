import { once } from 'node:events';

import type { ConfirmChannel } from 'amqplib';

export interface OutboxRow {
  readonly id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly occurred_at: Date;
  readonly payload: Record<string, unknown>;
}

export class OutboxConfirmTimeoutError extends Error {
  readonly code = 'OUTBOX_CONFIRM_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`RabbitMQ publication exceeded ${timeoutMs}ms before publisher confirms`);
    this.name = 'OutboxConfirmTimeoutError';
  }
}

function remainingTimeoutMs(deadlineAt: number, configuredTimeoutMs: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new OutboxConfirmTimeoutError(configuredTimeoutMs);
  return remaining;
}

async function waitForDrain(
  channel: ConfirmChannel,
  deadlineAt: number | undefined,
  configuredTimeoutMs: number | undefined,
): Promise<void> {
  if (deadlineAt === undefined || configuredTimeoutMs === undefined) {
    await once(channel, 'drain');
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        cleanup();
        reject(new OutboxConfirmTimeoutError(configuredTimeoutMs));
      },
      remainingTimeoutMs(deadlineAt, configuredTimeoutMs),
    );
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      channel.off('drain', onDrain);
      channel.off('error', onError);
    };
    channel.once('drain', onDrain);
    channel.once('error', onError);
  });
}

async function waitForConfirms(
  channel: ConfirmChannel,
  confirmTimeoutMs: number | undefined,
  deadlineAt: number | undefined,
): Promise<void> {
  const pendingConfirms = channel.waitForConfirms();
  if (confirmTimeoutMs === undefined || deadlineAt === undefined) {
    await pendingConfirms;
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pendingConfirms,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new OutboxConfirmTimeoutError(confirmTimeoutMs)),
          remainingTimeoutMs(deadlineAt, confirmTimeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function publishOutboxRows(options: {
  readonly channel: ConfirmChannel;
  readonly rows: readonly OutboxRow[];
  readonly confirmTimeoutMs?: number;
}): Promise<void> {
  const deadlineAt =
    options.confirmTimeoutMs === undefined ? undefined : Date.now() + options.confirmTimeoutMs;
  for (const row of options.rows) {
    const body = Buffer.from(
      JSON.stringify({
        id: row.id,
        type: row.event_type,
        aggregateId: row.aggregate_id,
        tenantId: row.tenant_id,
        occurredAt: row.occurred_at.toISOString(),
        correlationId: row.correlation_id,
        payload: row.payload,
      }),
    );
    const accepted = options.channel.publish('phub.events', row.event_type, body, {
      persistent: true,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      messageId: row.id,
      correlationId: row.correlation_id,
      timestamp: row.occurred_at.getTime(),
      headers: { tenantId: row.tenant_id },
    });
    if (!accepted) {
      await waitForDrain(options.channel, deadlineAt, options.confirmTimeoutMs);
    }
  }

  if (options.rows.length > 0) {
    await waitForConfirms(options.channel, options.confirmTimeoutMs, deadlineAt);
  }
}
