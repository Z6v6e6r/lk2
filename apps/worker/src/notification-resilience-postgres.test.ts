import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { GameNotificationSourceEvent } from '@phub/notifications';
import { createNotificationInboxRepository, withTenantTransaction } from '@phub/database';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyNotificationSourceEvent,
  type NotificationProjectionResult,
} from './notification-projector.js';

const connectionString = process.env.NOTIFICATION_RESILIENCE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const applicationName = 'notification-resilience-postgres-test';
const deadlineMs = 10_000;

function deadline<TResult>(promise: Promise<TResult>, label: string): Promise<TResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const detector = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`POSTGRES_TEST_TIMEOUT:${label}`)), deadlineMs);
  });
  return Promise.race([promise, detector]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function waitForLockWaiters(
  observer: PoolClient,
  applicationNamePattern: string,
  minimum: number,
  label: string,
): Promise<void> {
  const expiresAt = Date.now() + deadlineMs;
  while (Date.now() < expiresAt) {
    const result = await observer.query<{ count: string }>(
      `select count(*)::text as count
         from pg_stat_activity
        where application_name like $1
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
      [applicationNamePattern],
    );
    if (Number(result.rows[0]?.count ?? '0') >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`POSTGRES_TEST_TIMEOUT:${label}`);
}

function childProjection(event: GameNotificationSourceEvent): {
  readonly child: ChildProcess;
  readonly result: Promise<NotificationProjectionResult>;
} {
  const child = fork(new URL('./notification-projector-process-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      NOTIFICATION_RESILIENCE_TEST_DATABASE_URL: connectionString,
      NOTIFICATION_RESILIENCE_TEST_EVENT: JSON.stringify(event),
    },
    silent: true,
  });
  const result = new Promise<NotificationProjectionResult>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'ok' in message &&
        message.ok === true &&
        'result' in message
      ) {
        resolve(message.result as NotificationProjectionResult);
      } else {
        reject(new Error(`PROJECTOR_CHILD_FAILED:${JSON.stringify(message)}:${stderr}`));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`PROJECTOR_CHILD_EXITED:${String(code)}:${stderr}`));
    });
  });
  return { child, result };
}

describePostgres('GAME notification real PostgreSQL resilience', () => {
  let pool: Pool;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const secondUserId = randomUUID();
  const foreignTenantId = randomUUID();
  const foreignUserId = randomUUID();
  const templateId = randomUUID();
  const ruleId = randomUUID();

  function event(
    options: {
      readonly id?: string;
      readonly gameId?: string;
      readonly revision?: string;
      readonly recipientUserId?: string;
    } = {},
  ): GameNotificationSourceEvent {
    const gameId = options.gameId ?? randomUUID();
    const recipientUserId = options.recipientUserId ?? userId;
    return {
      id: options.id ?? randomUUID(),
      type: 'game.participation.confirmed.v1',
      aggregateId: gameId,
      tenantId,
      occurredAt: '2026-09-01T00:00:00.000Z',
      correlationId: `notification-resilience-${randomUUID()}`,
      payload: {
        gameId,
        aggregateRevision: options.revision ?? '1',
        causationId: randomUUID(),
        actorUserId: userId,
        userId: recipientUserId,
        participationId: randomUUID(),
      },
    };
  }

  async function count(table: string, where: string, values: readonly unknown[]): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from ${table} where ${where}`,
        [...values],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  beforeAll(async () => {
    if (!connectionString) throw new Error('NOTIFICATION_RESILIENCE_TEST_DATABASE_URL_REQUIRED');
    const url = new URL(connectionString);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.pathname.endsWith('_verify')
    ) {
      throw new Error('NOTIFICATION_RESILIENCE_DATABASE_MUST_BE_DISPOSABLE_LOOPBACK_VERIFY');
    }
    pool = new Pool({
      connectionString,
      max: 24,
      application_name: applicationName,
      options: '-c statement_timeout=12000 -c lock_timeout=12000',
    });
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'Notification resilience'), ($3, $4, 'Foreign notification resilience')`,
      [
        tenantId,
        `notification-resilience-${tenantId}`,
        foreignTenantId,
        `notification-resilience-${foreignTenantId}`,
      ],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         values ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE')`,
        [tenantId, userId, secondUserId],
      );
      await client.query(
        `insert into notifications.tenant_runtime_settings (tenant_id, in_app_enabled)
         values ($1, true)`,
        [tenantId],
      );
      await client.query(
        `insert into notifications.templates (
           tenant_id, id, template_key, version, category, channels,
           title_template, body_template, deep_link_template, active
         ) values ($1, $2, 'game.resilience', 1, 'GAME', array['IN_APP'],
                   'Игра', 'Статус игры', '/games/{{gameId}}', true)`,
        [tenantId, templateId],
      );
      await client.query(
        `insert into notifications.trigger_rules (
           tenant_id, id, rule_key, source_event_type, template_id,
           audience_selector, mandatory, active
         ) values ($1, $2, 'game.resilience', 'game.participation.confirmed.v1', $3,
                   '{"type":"EVENT_USER","field":"userId"}'::jsonb, true, true)`,
        [tenantId, ruleId, templateId],
      );
    });
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
        [foreignTenantId, foreignUserId],
      );
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('applies the exact same event 2, 10 and 100 times without duplicate projection', async () => {
    for (const deliveries of [2, 10, 100]) {
      const source = event();
      const results = await deadline(
        Promise.all(
          Array.from({ length: deliveries }, () =>
            applyNotificationSourceEvent({ pool, event: source }),
          ),
        ),
        `duplicate-${deliveries}`,
      );
      expect(results.filter((result) => result.outcome === 'processed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'duplicate')).toHaveLength(
        deliveries - 1,
      );
      await expect(
        count('notifications.intents', 'tenant_id = $1 and source_event_id = $2', [
          tenantId,
          source.id,
        ]),
      ).resolves.toBe(1);
    }
  }, 30_000);

  it('suppresses an old event after a newer projection and rolls back a failed projection for replay', async () => {
    const gameId = randomUUID();
    const newer = event({ gameId, revision: '3' });
    const older = event({ gameId, revision: '2' });
    await expect(applyNotificationSourceEvent({ pool, event: newer })).resolves.toMatchObject({
      outcome: 'processed',
    });
    await expect(applyNotificationSourceEvent({ pool, event: older })).resolves.toEqual({
      outcome: 'stale',
    });
    await expect(
      count('notifications.intents', 'tenant_id = $1 and source_event_id = $2', [
        tenantId,
        older.id,
      ]),
    ).resolves.toBe(0);

    const replay = event();
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update notifications.trigger_rules
            set audience_selector = '{"type":"UNKNOWN"}'::jsonb
          where tenant_id = $1 and id = $2`,
        [tenantId, ruleId],
      ),
    );
    await expect(applyNotificationSourceEvent({ pool, event: replay })).rejects.toThrow();
    await expect(
      count('audit.inbox_events', 'tenant_id = $1 and event_id = $2', [tenantId, replay.id]),
    ).resolves.toBe(0);
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update notifications.trigger_rules
            set audience_selector = '{"type":"EVENT_USER","field":"userId"}'::jsonb
          where tenant_id = $1 and id = $2`,
        [tenantId, ruleId],
      ),
    );
    await expect(applyNotificationSourceEvent({ pool, event: replay })).resolves.toMatchObject({
      outcome: 'processed',
    });
  });

  it('serializes two projector processes and keeps recipients and tenants isolated', async () => {
    const observer = await pool.connect();
    const gameId = randomUUID();
    const left = event({ gameId, revision: '1' });
    const right = { ...left, id: randomUUID(), correlationId: `second-${randomUUID()}` };
    const lockKey = `${tenantId}:${gameId}`;
    const children: ChildProcess[] = [];
    try {
      await observer.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      const first = childProjection(left);
      const second = childProjection(right);
      children.push(first.child, second.child);
      await waitForLockWaiters(observer, 'notification-projector-process-%', 2, 'two-process-race');
      await observer.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      await expect(
        deadline(Promise.all([first.result, second.result]), 'two-process-results'),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: 'processed' }),
          { outcome: 'duplicate' },
        ]),
      );
      await expect(
        count('notifications.intents', 'tenant_id = $1 and source_event_id = any($2::uuid[])', [
          tenantId,
          [left.id, right.id],
        ]),
      ).resolves.toBe(1);

      const spoofed = event({ recipientUserId: foreignUserId });
      await expect(applyNotificationSourceEvent({ pool, event: spoofed })).resolves.toMatchObject({
        outcome: 'processed',
        created: 0,
      });
      await expect(
        count('notifications.intents', 'tenant_id = $1 and source_event_id = $2', [
          tenantId,
          spoofed.id,
        ]),
      ).resolves.toBe(0);
    } finally {
      await observer
        .query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
        .catch(() => undefined);
      for (const child of children) child.kill();
      observer.release();
    }
  });

  it('keeps the first multi-tab read cursor monotonic and a later arrival unread', async () => {
    const first = event();
    const second = event();
    await applyNotificationSourceEvent({ pool, event: first });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await applyNotificationSourceEvent({ pool, event: second });
    const items = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ id: string; created_at: string }>(
        `select item.id, item.created_at::text as created_at
           from notifications.inbox_items item
           join notifications.intents intent
             on intent.tenant_id = item.tenant_id and intent.id = item.intent_id
          where item.tenant_id = $1 and item.user_id = $2
            and intent.source_event_id = any($3::uuid[])
          order by item.created_at desc, item.id desc`,
        [tenantId, userId, [first.id, second.id]],
      );
      return result.rows;
    });
    expect(items).toHaveLength(2);
    const newer = items[0]!;
    const older = items[1]!;
    const repository = createNotificationInboxRepository(pool);
    const observer = await pool.connect();
    const lockKey = `${tenantId}:NOTIFICATION_READ:${userId}`;
    try {
      await observer.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      const newerRead = repository.markReadThrough({
        tenantId,
        userId,
        throughItemId: newer.id,
        idempotencyKey: 'notification-newer-read-command-0001',
        correlationId: 'notification-newer-read-correlation-0001',
      });
      await waitForLockWaiters(observer, `${applicationName}%`, 1, 'newer-read-waiter');
      const olderRead = repository.markReadThrough({
        tenantId,
        userId,
        throughItemId: older.id,
        idempotencyKey: 'notification-older-read-command-0001',
        correlationId: 'notification-older-read-correlation-0001',
      });
      await waitForLockWaiters(observer, `${applicationName}%`, 2, 'two-read-waiters');
      await observer.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      const readResults = await deadline(Promise.all([newerRead, olderRead]), 'read-race');
      for (const result of readResults) {
        expect(result).toMatchObject({ outcome: 'updated', replayed: false });
        if (result.outcome !== 'updated') throw new Error('Read-race command was not updated');
        expect(result.readThrough.id).toBe(newer.id);
      }
      const stored = await withTenantTransaction(pool, tenantId, async (client) =>
        client.query<{ read_through_item_id: string }>(
          `select read_through_item_id
             from notifications.user_read_state
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        ),
      );
      expect(stored.rows[0]?.read_through_item_id).toBe(newer.id);
    } finally {
      await observer
        .query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
        .catch(() => undefined);
      observer.release();
    }

    const replayedRead = await repository.markReadThrough({
      tenantId,
      userId,
      throughItemId: newer.id,
      idempotencyKey: 'notification-newer-read-command-0001',
      correlationId: 'notification-newer-read-replay-correlation-0001',
    });
    expect(replayedRead).toMatchObject({ outcome: 'updated', replayed: true });
    if (replayedRead.outcome !== 'updated') throw new Error('Read replay was not updated');
    expect(replayedRead.changedCount).toBeGreaterThan(0);
    await expect(
      repository.markReadThrough({
        tenantId,
        userId,
        throughItemId: older.id,
        idempotencyKey: 'notification-newer-read-command-0001',
        correlationId: 'notification-read-conflict-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });

    const later = event();
    await applyNotificationSourceEvent({ pool, event: later });
    const unread = await repository.listInbox({ tenantId, userId, limit: 100, unreadOnly: true });
    expect(unread).toMatchObject({
      unreadCount: 1,
      items: [expect.objectContaining({ category: 'GAME' })],
    });
    expect(unread.items[0]).not.toHaveProperty('readAt');
    await expect(
      repository.markReadThrough({
        tenantId,
        userId: secondUserId,
        throughItemId: newer.id,
        idempotencyKey: 'notification-wrong-user-command-0001',
        correlationId: 'notification-wrong-user-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});
