import { createDatabasePool } from '@phub/database';
import { connect } from 'amqplib';
import type { Logger } from 'pino';

import { publishLeasedOutboxBatch } from '../apps/worker/src/leased-outbox-publisher.js';

type SoakWorkerMode = 'drain' | 'crash-after-claim' | 'crash-after-confirm';

const CRASH_AFTER_CLAIM_EXIT_CODE = 86;
const CRASH_AFTER_CONFIRM_EXIT_CODE = 87;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const databaseUrl = requiredEnvironment('DATABASE_URL');
const rabbitmqUrl = requiredEnvironment('RABBITMQ_URL');
const tenantId = requiredEnvironment('OUTBOX_SOAK_TENANT_ID');
const mode = requiredEnvironment('OUTBOX_SOAK_WORKER_MODE') as SoakWorkerMode;
if (!['drain', 'crash-after-claim', 'crash-after-confirm'].includes(mode)) {
  throw new Error('OUTBOX_SOAK_WORKER_MODE is invalid');
}
const batchSize = positiveIntegerEnvironment('OUTBOX_SOAK_BATCH_SIZE');
const claimTtlMs = positiveIntegerEnvironment('OUTBOX_SOAK_CLAIM_TTL_MS');
const confirmTimeoutMs = positiveIntegerEnvironment('OUTBOX_SOAK_CONFIRM_TIMEOUT_MS');
const failureBackoffMs = positiveIntegerEnvironment('OUTBOX_SOAK_FAILURE_BACKOFF_MS');
const fixedClaimToken = process.env.OUTBOX_SOAK_CLAIM_TOKEN?.trim();
const pool = createDatabasePool(databaseUrl);
const connection = await connect(rabbitmqUrl);
const channel = await connection.createConfirmChannel();
const logger = { error: () => undefined } as unknown as Logger;
let publishedCount = 0;

try {
  while (true) {
    const published = await publishLeasedOutboxBatch({
      pool,
      channel,
      logger,
      tenantId,
      batchSize,
      claimTtlMs,
      confirmTimeoutMs,
      failureBackoffMs,
      ...(fixedClaimToken ? { claimTokenFactory: () => fixedClaimToken } : {}),
      ...(mode === 'crash-after-claim'
        ? {
            verificationHooks: {
              afterClaim: () => process.exit(CRASH_AFTER_CLAIM_EXIT_CODE),
            },
          }
        : {}),
      ...(mode === 'crash-after-confirm'
        ? {
            verificationHooks: {
              afterConfirm: () => process.exit(CRASH_AFTER_CONFIRM_EXIT_CODE),
            },
          }
        : {}),
    });
    publishedCount += published;
    if (mode !== 'drain') {
      throw new Error(`Expected ${mode} verification hook did not terminate the process`);
    }
    if (published === 0) break;
  }

  process.stdout.write(`${JSON.stringify({ mode, publishedCount })}\n`);
} finally {
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await pool.end();
}
