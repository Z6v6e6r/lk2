import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { createDatabasePool, withTenantTransaction } from '@phub/database';
import { connect, type Channel, type ConsumeMessage } from 'amqplib';

import {
  DEAD_LETTER_QUEUE,
  EVENT_EXCHANGE,
  registerCoreBrokerTopology,
} from '../apps/worker/src/broker-topology.js';
import { collectWorkerOperationalSnapshot } from '../apps/worker/src/operational-metrics.js';

type SoakWorkerMode = 'drain' | 'crash-after-claim' | 'crash-after-confirm';

const CRASH_AFTER_CLAIM_EXIT_CODE = 86;
const CRASH_AFTER_CONFIRM_EXIT_CODE = 87;
const CLAIM_CRASH_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM_CRASH_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ROUTING_KEY = 'verification.outbox.soak.v1';
const EVENT_QUEUE = 'phub.outbox.soak.verify.v1';
const workerPath = fileURLToPath(new URL('./verify-outbox-lease-soak-worker.ts', import.meta.url));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireIsolatedTarget(urlValue: string, kind: string): void {
  const name = decodeURIComponent(new URL(urlValue).pathname.replace(/^\//, ''));
  if (!name.endsWith('_verify')) {
    throw new Error(`${kind} must target an isolated *_verify database or vhost`);
  }
}

const databaseUrl = requiredEnvironment('DATABASE_URL');
const rabbitmqUrl = requiredEnvironment('RABBITMQ_URL');
requireIsolatedTarget(databaseUrl, 'DATABASE_URL');
requireIsolatedTarget(rabbitmqUrl, 'RABBITMQ_URL');
const eventCount = boundedInteger('OUTBOX_SOAK_EVENT_COUNT', 5_000, 500, 50_000);
const concurrency = boundedInteger('OUTBOX_SOAK_CONCURRENCY', 4, 2, 8);
const batchSize = boundedInteger('OUTBOX_SOAK_BATCH_SIZE', 50, 10, 500);
const claimTtlMs = boundedInteger('OUTBOX_SOAK_CLAIM_TTL_MS', 10_000, 10_000, 60_000);
const confirmTimeoutMs = boundedInteger('OUTBOX_SOAK_CONFIRM_TIMEOUT_MS', 1_000, 500, 10_000);
const failureBackoffMs = boundedInteger('OUTBOX_SOAK_FAILURE_BACKOFF_MS', 1_000, 500, 10_000);
if (eventCount < batchSize * 4) {
  throw new Error('OUTBOX_SOAK_EVENT_COUNT must be at least four batches');
}
if (claimTtlMs - confirmTimeoutMs < 5_000) {
  throw new Error('OUTBOX_SOAK_CLAIM_TTL_MS must exceed confirm timeout by at least 5000ms');
}

const tenantId = randomUUID();
const pool = createDatabasePool(databaseUrl);
const connection = await connect(rabbitmqUrl);
connection.on('error', () => undefined);
const channel = await connection.createChannel();
const startedAt = performance.now();

async function runWorker(
  mode: SoakWorkerMode,
  expectedExitCode: number,
  claimToken?: string,
): Promise<void> {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    RABBITMQ_URL: rabbitmqUrl,
    OUTBOX_SOAK_TENANT_ID: tenantId,
    OUTBOX_SOAK_WORKER_MODE: mode,
    OUTBOX_SOAK_BATCH_SIZE: String(batchSize),
    OUTBOX_SOAK_CLAIM_TTL_MS: String(claimTtlMs),
    OUTBOX_SOAK_CONFIRM_TIMEOUT_MS: String(confirmTimeoutMs),
    OUTBOX_SOAK_FAILURE_BACKOFF_MS: String(failureBackoffMs),
  };
  if (claimToken) {
    childEnvironment.OUTBOX_SOAK_CLAIM_TOKEN = claimToken;
  } else {
    delete childEnvironment.OUTBOX_SOAK_CLAIM_TOKEN;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let standardOutput = '';
  let standardError = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    standardOutput = `${standardOutput}${chunk}`.slice(-8_000);
  });
  child.stderr.on('data', (chunk: string) => {
    standardError = `${standardError}${chunk}`.slice(-8_000);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => clearTimeout(timeout));

  if (timedOut || result.code !== expectedExitCode) {
    throw new Error(
      `Soak worker ${mode} failed: ${JSON.stringify({
        expectedExitCode,
        actualExitCode: result.code,
        signal: result.signal,
        timedOut,
        standardOutput: standardOutput.trim(),
        standardError: standardError.trim(),
      })}`,
    );
  }
}

async function claimedEventIds(claimToken: string): Promise<readonly string[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `select id
         from audit.outbox_events
        where tenant_id = $1
          and publish_claim_token = $2::uuid
          and published_at is null
        order by id`,
      [tenantId, claimToken],
    );
    return result.rows.map((row) => row.id);
  });
}

async function readDatabaseState(): Promise<{
  readonly total: number;
  readonly published: number;
  readonly unpublished: number;
  readonly activeClaims: number;
  readonly attemptsOnce: number;
  readonly attemptsTwice: number;
  readonly attemptsOther: number;
}> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      total: number;
      published: number;
      unpublished: number;
      active_claims: number;
      attempts_once: number;
      attempts_twice: number;
      attempts_other: number;
    }>(
      `select count(*)::integer as total,
              (count(*) filter (where published_at is not null))::integer as published,
              (count(*) filter (where published_at is null))::integer as unpublished,
              (count(*) filter (
                where published_at is null and publish_claim_token is not null
              ))::integer as active_claims,
              (count(*) filter (where publish_attempts = 1))::integer as attempts_once,
              (count(*) filter (where publish_attempts = 2))::integer as attempts_twice,
              (count(*) filter (where publish_attempts not in (1, 2)))::integer as attempts_other
         from audit.outbox_events
        where tenant_id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Outbox soak database state is missing');
    return {
      total: row.total,
      published: row.published,
      unpublished: row.unpublished,
      activeClaims: row.active_claims,
      attemptsOnce: row.attempts_once,
      attemptsTwice: row.attempts_twice,
      attemptsOther: row.attempts_other,
    };
  });
}

async function millisecondsUntilClaimsExpire(): Promise<number> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{ wait_ms: number }>(
      `select ceil(greatest(
                0,
                extract(epoch from (max(publish_claim_expires_at) - clock_timestamp())) * 1000
              ))::integer as wait_ms
         from audit.outbox_events
        where tenant_id = $1
          and published_at is null
          and publish_claim_token is not null`,
      [tenantId],
    );
    return result.rows[0]?.wait_ms ?? 0;
  });
}

async function consumeMessageCounts(
  consumerChannel: Channel,
  expectedMessages: number,
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  let received = 0;
  let resolveExpected: (() => void) | undefined;
  const reachedExpected = new Promise<void>((resolve) => {
    resolveExpected = resolve;
  });
  await consumerChannel.prefetch(1_000);
  const consumer = await consumerChannel.consume(
    EVENT_QUEUE,
    (message: ConsumeMessage | null) => {
      if (!message) return;
      const messageId: unknown = message.properties.messageId;
      if (typeof messageId !== 'string') {
        consumerChannel.nack(message, false, false);
        return;
      }
      counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
      received += 1;
      consumerChannel.ack(message);
      if (received === expectedMessages) resolveExpected?.();
    },
    { noAck: false },
  );

  try {
    await Promise.race([
      reachedExpected,
      delay(30_000).then(() => {
        throw new Error(`Timed out after receiving ${received}/${expectedMessages} messages`);
      }),
    ]);
  } finally {
    await consumerChannel.cancel(consumer.consumerTag);
  }
  if (received !== expectedMessages) {
    throw new Error(`Expected ${expectedMessages} messages, received ${received}`);
  }
  return counts;
}

let tenantCreated = false;
try {
  await registerCoreBrokerTopology(channel);
  await channel.assertQueue(EVENT_QUEUE, { durable: true, autoDelete: false });
  await channel.bindQueue(EVENT_QUEUE, EVENT_EXCHANGE, EVENT_ROUTING_KEY);
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, $2, 'Outbox real RabbitMQ soak verification')`,
    [tenantId, `outbox-soak-${tenantId.slice(0, 8)}`],
  );
  tenantCreated = true;
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into audit.outbox_events (
         tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       )
       select $1, $2, gen_random_uuid(), 'outbox-soak-' || source.ordinality,
              jsonb_build_object('sequence', source.ordinality),
              clock_timestamp() + source.ordinality * interval '1 microsecond'
         from generate_series(1, $3::integer) with ordinality source(value, ordinality)`,
      [tenantId, EVENT_ROUTING_KEY, eventCount],
    );
  });

  await runWorker('crash-after-claim', CRASH_AFTER_CLAIM_EXIT_CODE, CLAIM_CRASH_TOKEN);
  const claimCrashIds = await claimedEventIds(CLAIM_CRASH_TOKEN);
  if (claimCrashIds.length !== batchSize) {
    throw new Error(`Crash-after-claim retained ${claimCrashIds.length}/${batchSize} claims`);
  }
  const queueAfterClaimCrash = await channel.checkQueue(EVENT_QUEUE);
  if (queueAfterClaimCrash.messageCount !== 0) {
    throw new Error('Crash-after-claim published messages before the forced process exit');
  }

  await runWorker('crash-after-confirm', CRASH_AFTER_CONFIRM_EXIT_CODE, CONFIRM_CRASH_TOKEN);
  const confirmCrashIds = await claimedEventIds(CONFIRM_CRASH_TOKEN);
  if (confirmCrashIds.length !== batchSize) {
    throw new Error(`Crash-after-confirm retained ${confirmCrashIds.length}/${batchSize} claims`);
  }
  const queueAfterConfirmCrash = await channel.checkQueue(EVENT_QUEUE);
  if (queueAfterConfirmCrash.messageCount !== batchSize) {
    throw new Error(
      `Crash-after-confirm retained ${queueAfterConfirmCrash.messageCount}/${batchSize} messages`,
    );
  }

  const degradedSnapshot = await collectWorkerOperationalSnapshot({ pool, channel });
  if (
    degradedSnapshot.outboxBackloggedTenants !== 1 ||
    degradedSnapshot.outboxOldestAgeSeconds <= 0 ||
    degradedSnapshot.deadLetterMessagesReady !== 0
  ) {
    throw new Error(
      `Degraded operational snapshot is invalid: ${JSON.stringify(degradedSnapshot)}`,
    );
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker('drain', 0)));
  const beforeLeaseRecovery = await readDatabaseState();
  if (
    beforeLeaseRecovery.published !== eventCount - batchSize * 2 ||
    beforeLeaseRecovery.unpublished !== batchSize * 2 ||
    beforeLeaseRecovery.activeClaims !== batchSize * 2
  ) {
    throw new Error(`Unexpired lease isolation failed: ${JSON.stringify(beforeLeaseRecovery)}`);
  }

  await delay((await millisecondsUntilClaimsExpire()) + 250);
  await Promise.all(Array.from({ length: concurrency }, () => runWorker('drain', 0)));

  const finalDatabaseState = await readDatabaseState();
  if (
    finalDatabaseState.total !== eventCount ||
    finalDatabaseState.published !== eventCount ||
    finalDatabaseState.unpublished !== 0 ||
    finalDatabaseState.activeClaims !== 0 ||
    finalDatabaseState.attemptsOnce !== eventCount - batchSize * 2 ||
    finalDatabaseState.attemptsTwice !== batchSize * 2 ||
    finalDatabaseState.attemptsOther !== 0
  ) {
    throw new Error(`Final database invariants failed: ${JSON.stringify(finalDatabaseState)}`);
  }

  const expectedMessages = eventCount + batchSize;
  const queueBeforeConsume = await channel.checkQueue(EVENT_QUEUE);
  if (queueBeforeConsume.messageCount !== expectedMessages) {
    throw new Error(
      `Expected ${expectedMessages} retained messages, found ${queueBeforeConsume.messageCount}`,
    );
  }
  const messageCounts = await consumeMessageCounts(channel, expectedMessages);
  const duplicateIds = [...messageCounts.entries()]
    .filter(([, count]) => count === 2)
    .map(([messageId]) => messageId)
    .sort();
  const invalidMultiplicities = [...messageCounts.values()].filter(
    (count) => count !== 1 && count !== 2,
  );
  if (
    messageCounts.size !== eventCount ||
    duplicateIds.length !== batchSize ||
    invalidMultiplicities.length > 0 ||
    duplicateIds.join(',') !== [...confirmCrashIds].sort().join(',')
  ) {
    throw new Error(
      `At-least-once duplicate invariant failed: ${JSON.stringify({
        uniqueMessages: messageCounts.size,
        duplicateMessages: duplicateIds.length,
        invalidMultiplicities: invalidMultiplicities.length,
      })}`,
    );
  }

  await delay(100);
  const finalSnapshot = await collectWorkerOperationalSnapshot({ pool, channel });
  const eventQueueAfterConsume = await channel.checkQueue(EVENT_QUEUE);
  const deadLetterQueue = await channel.checkQueue(DEAD_LETTER_QUEUE);
  if (
    finalSnapshot.outboxOldestAgeSeconds !== 0 ||
    finalSnapshot.outboxBackloggedTenants !== 0 ||
    finalSnapshot.deadLetterMessagesReady !== 0 ||
    eventQueueAfterConsume.messageCount !== 0 ||
    deadLetterQueue.messageCount !== 0
  ) {
    throw new Error(
      `Final operational snapshot is invalid: ${JSON.stringify({
        finalSnapshot,
        eventMessagesReady: eventQueueAfterConsume.messageCount,
        deadLetterMessagesReady: deadLetterQueue.messageCount,
      })}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        transport: 'real-rabbitmq-confirm-channel',
        eventCount,
        concurrency,
        batchSize,
        forcedCrashes: ['after-claim', 'after-confirm'],
        recoveredClaims: claimCrashIds.length + confirmCrashIds.length,
        confirmedCrashDuplicates: duplicateIds.length,
        uniqueMessages: messageCounts.size,
        deadLetterMessages: deadLetterQueue.messageCount,
        degradedSnapshot,
        finalSnapshot,
        finalDatabaseState,
        durationMs: Math.round(performance.now() - startedAt),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (tenantCreated) {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('delete from audit.outbox_events where tenant_id = $1', [tenantId]);
    }).catch(() => undefined);
    await pool
      .query('delete from identity.tenants where id = $1', [tenantId])
      .catch(() => undefined);
  }
  await channel.deleteQueue(EVENT_QUEUE).catch(() => undefined);
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await pool.end();
}
