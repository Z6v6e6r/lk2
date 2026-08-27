import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  createMessagingRepository,
  type MessagingRepository,
  type SendConversationMessageResult,
} from './messaging-repository.js';

const suppliedRuntimeConnectionString = process.env.MESSAGING_CONCURRENCY_TEST_DATABASE_URL;
const ciAdminConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const describePostgres =
  suppliedRuntimeConnectionString || ciAdminConnectionString ? describe : describe.skip;
const applicationName = 'phub-messaging-concurrency-test';
const deadlineMs = 6_000;

type LockWaiter = {
  readonly pid: number;
  readonly wait_event_type: string | null;
  readonly wait_event: string | null;
};

function deadline<TResult>(promise: Promise<TResult>, label: string): Promise<TResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const detector = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`POSTGRES_TEST_TIMEOUT:${label}`)), deadlineMs);
  });
  return Promise.race([promise, detector]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function settle(...promises: readonly (Promise<unknown> | undefined)[]): Promise<void> {
  await Promise.allSettled(
    promises.filter((promise): promise is Promise<unknown> => promise !== undefined),
  );
}

async function waitForLockWaiters(
  observer: PoolClient,
  minimum: number,
  label: string,
  timeoutMs = deadlineMs,
): Promise<readonly LockWaiter[]> {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const result = await observer.query<LockWaiter>(
      `select pid, wait_event_type, wait_event
             from pg_stat_activity
            where application_name = $1
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
            order by pid`,
      [applicationName],
    );
    if (result.rows.length >= minimum) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`POSTGRES_TEST_TIMEOUT:${label}`);
}

describePostgres('GAME messaging real PostgreSQL concurrency and forced-RLS invariants', () => {
  let pool: Pool;
  let repository: MessagingRepository;
  let adminPool: Pool | undefined;
  let disposableRuntimeRole: string | undefined;
  let disposableRuntimePassword: string | undefined;
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const userId = randomUUID();
  const foreignUserId = randomUUID();

  async function seedTenant(
    seedTenantId: string,
    seedUserId: string,
    label: string,
  ): Promise<void> {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, $3)`,
      [seedTenantId, `messaging-pg-${label}-${seedTenantId}`, `Messaging PostgreSQL ${label}`],
    );
    await withTenantTransaction(pool, seedTenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         values ($1, $2, 'ACTIVE')`,
        [seedTenantId, seedUserId],
      );
      await client.query(
        `insert into identity.user_access_profiles (tenant_id, user_id, roles, permissions)
         values ($1, $2, array['client']::text[], array['games.play']::text[])`,
        [seedTenantId, seedUserId],
      );
      await client.query(
        `insert into messaging.tenant_runtime_settings (
           tenant_id, http_enabled, contextual_enabled
         ) values ($1, true, true)`,
        [seedTenantId],
      );
    });
  }

  async function seedGameConversation(label: string): Promise<{
    readonly conversationId: string;
    readonly gameId: string;
    readonly participationId: string;
  }> {
    const gameId = randomUUID();
    const conversationId = randomUUID();
    const participationId = randomUUID();
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into games.games (
           tenant_id, id, organizer_user_id, title, kind, visibility, lifecycle_state,
           station_id, starts_at, ends_at, timezone, capacity, waitlist_enabled, payment_mode
         ) values (
           $1, $2, $3, $4, 'FRIENDLY', 'PRIVATE', 'SCHEDULED',
           $5, now() + interval '1 day', now() + interval '2 days',
           'Europe/Moscow', 4, false, 'NO_PAYMENT'
         )`,
        [tenantId, gameId, userId, `PostgreSQL race ${label}`, randomUUID()],
      );
      await client.query(
        `insert into games.participations (
           tenant_id, game_id, id, user_id, role, state
         ) values ($1, $2, $3, $4, 'ORGANIZER', 'ACTIVE')`,
        [tenantId, gameId, participationId, userId],
      );
      await client.query(
        `insert into messaging.conversations (
           tenant_id, id, kind, context_type, context_id, title, created_by_user_id
         ) values ($1, $2, 'GAME', 'GAME', $3, $4, $5)`,
        [tenantId, conversationId, gameId, `PostgreSQL race ${label}`, userId],
      );
      await client.query(
        `insert into messaging.conversation_members (
           tenant_id, conversation_id, member_type, user_id, role, state
         ) values ($1, $2, 'USER', $3, 'OWNER', 'ACTIVE')`,
        [tenantId, conversationId, userId],
      );
    });
    return { conversationId, gameId, participationId };
  }

  function sendInput(
    conversationId: string,
    label: string,
    overrides: { readonly clientMessageId?: string; readonly idempotencyKey?: string } = {},
  ) {
    return {
      tenantId,
      userId,
      conversationId,
      clientMessageId: overrides.clientMessageId ?? `${label}-client-message-0001`,
      idempotencyKey: overrides.idempotencyKey ?? `${label}-command-key-0001`,
      body: `PostgreSQL concurrency ${label}`,
      correlationId: `${label}-correlation-0001`,
    };
  }

  function commandLockKey(idempotencyKey: string): string {
    return `${tenantId}:MESSAGE_COMMAND:${userId}:${idempotencyKey}`;
  }

  function clientLockKey(clientMessageId: string): string {
    return `${tenantId}:MESSAGE_CLIENT:${userId}:${clientMessageId}`;
  }

  async function holdAdvisoryLock(client: PoolClient, key: string): Promise<void> {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [key]);
  }

  async function releaseAdvisoryLock(client: PoolClient, key: string): Promise<void> {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
  }

  async function countMessages(
    conversationIds: readonly string[],
    clientMessageId?: string,
    idempotencyKey?: string,
  ): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
           from messaging.messages
          where conversation_id = any($1::uuid[])
            and ($2::text is null or client_message_id = $2)
            and ($3::text is null or idempotency_key = $3)`,
        [conversationIds, clientMessageId ?? null, idempotencyKey ?? null],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  beforeAll(async () => {
    let runtimeConnectionString = suppliedRuntimeConnectionString;
    if (!runtimeConnectionString) {
      if (!ciAdminConnectionString) throw new Error('POSTGRES_TEST_ADMIN_URL_REQUIRED');
      adminPool = new Pool({
        connectionString: ciAdminConnectionString,
        max: 2,
        application_name: `${applicationName}-admin`,
      });
      disposableRuntimeRole = `messaging_test_${randomUUID().replaceAll('-', '')}`;
      disposableRuntimePassword = randomUUID().replaceAll('-', '');
      await adminPool.query(
        `create role ${disposableRuntimeRole}
           login password '${disposableRuntimePassword}'
           nosuperuser nobypassrls nocreatedb nocreaterole noinherit`,
      );
      await adminPool.query(
        `grant usage on schema identity, profile, games, messaging, audit
           to ${disposableRuntimeRole}`,
      );
      await adminPool.query(`
        grant select, insert on identity.tenants to ${disposableRuntimeRole};
        grant select, insert on identity.users, identity.user_access_profiles
          to ${disposableRuntimeRole};
        grant select on profile.user_summaries, profile.privacy_settings
          to ${disposableRuntimeRole};
        grant select, insert on messaging.tenant_runtime_settings to ${disposableRuntimeRole};
        grant select on messaging.user_blocks to ${disposableRuntimeRole};
        grant select, insert, update on
          messaging.conversations, messaging.conversation_members, messaging.messages
          to ${disposableRuntimeRole};
        grant select, insert, update on games.games to ${disposableRuntimeRole};
        grant select, insert, update on games.participations to ${disposableRuntimeRole};
        grant insert on audit.outbox_events, audit.audit_log to ${disposableRuntimeRole};
      `);
      const runtimeUrl = new URL(ciAdminConnectionString);
      runtimeUrl.username = disposableRuntimeRole;
      runtimeUrl.password = disposableRuntimePassword;
      runtimeConnectionString = runtimeUrl.toString();
    }
    pool = new Pool({
      connectionString: runtimeConnectionString,
      max: 16,
      application_name: applicationName,
      options:
        '-c statement_timeout=7000 -c lock_timeout=7000 -c idle_in_transaction_session_timeout=7000',
    });
    repository = createMessagingRepository(pool);
    await seedTenant(tenantId, userId, 'primary');
    await seedTenant(foreignTenantId, foreignUserId, 'foreign');
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && disposableRuntimeRole) {
      await adminPool.query(`drop owned by ${disposableRuntimeRole}`);
      await adminPool.query(`drop role ${disposableRuntimeRole}`);
    }
    if (adminPool) await adminPool.end();
  });

  it('A: serializes one duplicate GAME command into one canonical message and one replay', async () => {
    const { conversationId } = await seedGameConversation('duplicate');
    const input = sendInput(conversationId, 'duplicate');
    const observer = await pool.connect();
    const barrierKey = commandLockKey(input.idempotencyKey);
    let first: Promise<SendConversationMessageResult> | undefined;
    let second: Promise<SendConversationMessageResult> | undefined;
    try {
      await holdAdvisoryLock(observer, barrierKey);
      first = repository.sendMessage(input);
      const firstWaiters = await waitForLockWaiters(observer, 1, 'A:first-advisory-waiter');
      second = repository.sendMessage(input);
      const concurrentWaiters = await waitForLockWaiters(observer, 2, 'A:two-physical-waiters');
      expect(
        new Set([...firstWaiters, ...concurrentWaiters].map((row) => row.pid)).size,
      ).toBeGreaterThanOrEqual(2);
      await releaseAdvisoryLock(observer, barrierKey);
      const results = await deadline(Promise.all([first, second]), 'A:completion');
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: 'ok', replayed: false }),
          expect.objectContaining({ outcome: 'ok', replayed: true }),
        ]),
      );
      const messageIds = results.flatMap((result) =>
        result.outcome === 'ok' ? [result.message.id] : [],
      );
      expect(new Set(messageIds).size).toBe(1);
      await expect(
        countMessages([conversationId], input.clientMessageId, input.idempotencyKey),
      ).resolves.toBe(1);
    } finally {
      await releaseAdvisoryLock(observer, barrierKey).catch(() => undefined);
      await settle(first, second);
      observer.release();
    }
  });

  it.each([
    { dimension: 'command', sharedCommand: true },
    { dimension: 'client-message', sharedCommand: false },
  ])(
    'B: rejects concurrent cross-conversation reuse of $dimension identity',
    async ({ sharedCommand }) => {
      const left = await seedGameConversation(`cross-left-${String(sharedCommand)}`);
      const right = await seedGameConversation(`cross-right-${String(sharedCommand)}`);
      const sharedId = `cross-conversation-${String(sharedCommand)}-identity-0001`;
      const leftInput = sendInput(left.conversationId, `cross-left-${String(sharedCommand)}`, {
        ...(sharedCommand ? { idempotencyKey: sharedId } : { clientMessageId: sharedId }),
      });
      const rightInput = sendInput(right.conversationId, `cross-right-${String(sharedCommand)}`, {
        ...(sharedCommand ? { idempotencyKey: sharedId } : { clientMessageId: sharedId }),
      });
      const observer = await pool.connect();
      const barrierKey = sharedCommand ? commandLockKey(sharedId) : clientLockKey(sharedId);
      let first: Promise<SendConversationMessageResult> | undefined;
      let second: Promise<SendConversationMessageResult> | undefined;
      try {
        await holdAdvisoryLock(observer, barrierKey);
        first = repository.sendMessage(leftInput);
        await waitForLockWaiters(observer, 1, 'B:first-shared-lock-waiter');
        second = repository.sendMessage(rightInput);
        const waiters = await waitForLockWaiters(observer, 2, 'B:two-shared-lock-waiters');
        expect(new Set(waiters.map((row) => row.pid)).size).toBeGreaterThanOrEqual(2);
        await releaseAdvisoryLock(observer, barrierKey);
        const results = await deadline(Promise.all([first, second]), 'B:completion');
        expect(results.filter((result) => result.outcome === 'ok')).toHaveLength(1);
        expect(results.filter((result) => result.outcome === 'idempotency_conflict')).toHaveLength(
          1,
        );
        await expect(
          countMessages(
            [left.conversationId, right.conversationId],
            sharedCommand ? undefined : sharedId,
            sharedCommand ? sharedId : undefined,
          ),
        ).resolves.toBe(1);
      } finally {
        await releaseAdvisoryLock(observer, barrierKey).catch(() => undefined);
        await settle(first, second);
        observer.release();
      }
    },
  );

  it('C: orders an in-flight send before revoke and rejects every send after canonical revoke', async () => {
    const { conversationId, participationId } = await seedGameConversation('revoke-race');
    const input = sendInput(conversationId, 'revoke-race');
    const observer = await pool.connect();
    const revoker = await pool.connect();
    const barrierKey = commandLockKey(input.idempotencyKey);
    let revokerInTransaction = false;
    let send: Promise<SendConversationMessageResult> | undefined;
    let revoke: Promise<QueryResult> | undefined;
    try {
      await holdAdvisoryLock(observer, barrierKey);
      send = repository.sendMessage(input);
      const sendWaiters = await waitForLockWaiters(observer, 1, 'C:send-holds-participation');
      await revoker.query('begin');
      revokerInTransaction = true;
      await revoker.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const revokerPid = (await revoker.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]?.pid;
      expect(revokerPid).toBeTypeOf('number');
      revoke = revoker.query(
        `update games.participations
            set state = 'REMOVED', left_at = now(), updated_at = now()
          where tenant_id = $1 and id = $2 and state = 'ACTIVE'`,
        [tenantId, participationId],
      );
      const waiters = await waitForLockWaiters(observer, 2, 'C:revoke-blocked-behind-send');
      expect(waiters.some((row) => row.pid === revokerPid)).toBe(true);
      expect(waiters.some((row) => sendWaiters.some((sendRow) => sendRow.pid === row.pid))).toBe(
        true,
      );
      await releaseAdvisoryLock(observer, barrierKey);
      await expect(deadline(send, 'C:send-completion')).resolves.toMatchObject({
        outcome: 'ok',
        replayed: false,
      });
      const revoked = await deadline(revoke, 'C:revoke-completion');
      expect(revoked.rowCount).toBe(1);
      await revoker.query('commit');
      revokerInTransaction = false;

      await expect(
        deadline(
          repository.sendMessage(sendInput(conversationId, 'after-canonical-revoke')),
          'C:post-revoke-send',
        ),
      ).resolves.toEqual({ outcome: 'not_found' });
      await expect(countMessages([conversationId])).resolves.toBe(1);
    } finally {
      await releaseAdvisoryLock(observer, barrierKey).catch(() => undefined);
      await settle(send, revoke);
      if (revokerInTransaction) await revoker.query('rollback').catch(() => undefined);
      revoker.release();
      observer.release();
    }
  });

  it('D: enforces forced RLS under a non-owner, non-superuser, non-bypass runtime role', async () => {
    const { conversationId } = await seedGameConversation('forced-rls');
    const sent = await repository.sendMessage(sendInput(conversationId, 'forced-rls'));
    expect(sent).toMatchObject({ outcome: 'ok' });
    if (sent.outcome !== 'ok') throw new Error('RLS seed message failed');

    const role = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select current_user, rolsuper, rolbypassrls
         from pg_roles
        where rolname = current_user`,
    );
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });

    const tables = await pool.query<{
      relname: string;
      owner_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select class.relname,
              pg_get_userbyid(class.relowner) as owner_name,
              class.relrowsecurity,
              class.relforcerowsecurity
         from pg_class class
         join pg_namespace namespace on namespace.oid = class.relnamespace
        where (namespace.nspname, class.relname) in (
          ('messaging', 'conversations'),
          ('messaging', 'messages'),
          ('games', 'games'),
          ('games', 'participations')
        )
        order by namespace.nspname, class.relname`,
    );
    expect(tables.rows).toHaveLength(4);
    for (const table of tables.rows) {
      expect(table.owner_name).not.toBe(role.rows[0]?.current_user);
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }

    await withTenantTransaction(pool, tenantId, async (client) => {
      const own = await client.query<{ count: string }>(
        'select count(*)::text as count from messaging.messages where id = $1',
        [sent.message.id],
      );
      expect(own.rows[0]?.count).toBe('1');
    });
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      const foreignRead = await client.query<{ count: string }>(
        'select count(*)::text as count from messaging.messages where id = $1',
        [sent.message.id],
      );
      expect(foreignRead.rows[0]?.count).toBe('0');
      const foreignWrite = await client.query(
        "update messaging.messages set body = 'foreign overwrite' where id = $1",
        [sent.message.id],
      );
      expect(foreignWrite.rowCount).toBe(0);
    });
    await expect(
      repository.sendMessage({
        ...sendInput(conversationId, 'foreign-tenant-rejection'),
        tenantId: foreignTenantId,
        userId: foreignUserId,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('E: completes swapped command/client inputs without deadlock under stable lock order', async () => {
    const left = await seedGameConversation('lock-order-left');
    const right = await seedGameConversation('lock-order-right');
    const alpha = 'lock-order-shared-alpha-0001';
    const beta = 'lock-order-shared-beta-0001';
    const leftInput = sendInput(left.conversationId, 'lock-order-left', {
      idempotencyKey: alpha,
      clientMessageId: beta,
    });
    const rightInput = sendInput(right.conversationId, 'lock-order-right', {
      idempotencyKey: beta,
      clientMessageId: alpha,
    });
    const commandBlocker = await pool.connect();
    const clientBlocker = await pool.connect();
    const commandOrderProbe = await pool.connect();
    const commandBarrier = commandLockKey(leftInput.idempotencyKey);
    const clientBarrier = clientLockKey(rightInput.clientMessageId);
    let leftSend: Promise<SendConversationMessageResult> | undefined;
    let rightSend: Promise<SendConversationMessageResult> | undefined;
    try {
      await holdAdvisoryLock(commandBlocker, commandBarrier);
      await holdAdvisoryLock(clientBlocker, clientBarrier);
      leftSend = repository.sendMessage(leftInput);
      rightSend = repository.sendMessage(rightInput);
      const waiters = await waitForLockWaiters(commandBlocker, 2, 'E:opposite-input-waiters');
      expect(new Set(waiters.map((row) => row.pid)).size).toBeGreaterThanOrEqual(2);
      const commandWasAvailable = (
        await commandOrderProbe.query<{ acquired: boolean }>(
          'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
          [commandLockKey(rightInput.idempotencyKey)],
        )
      ).rows[0]?.acquired;
      if (commandWasAvailable) {
        await releaseAdvisoryLock(commandOrderProbe, commandLockKey(rightInput.idempotencyKey));
      }
      expect(commandWasAvailable).toBe(false);
      await releaseAdvisoryLock(commandBlocker, commandBarrier);
      await releaseAdvisoryLock(clientBlocker, clientBarrier);
      await expect(deadline(Promise.all([leftSend, rightSend]), 'E:no-deadlock')).resolves.toEqual([
        expect.objectContaining({ outcome: 'ok', replayed: false }),
        expect.objectContaining({ outcome: 'ok', replayed: false }),
      ]);
      await expect(countMessages([left.conversationId, right.conversationId])).resolves.toBe(2);
    } finally {
      await releaseAdvisoryLock(commandBlocker, commandBarrier).catch(() => undefined);
      await releaseAdvisoryLock(clientBlocker, clientBarrier).catch(() => undefined);
      await releaseAdvisoryLock(commandOrderProbe, commandLockKey(rightInput.idempotencyKey)).catch(
        () => undefined,
      );
      await settle(leftSend, rightSend);
      commandBlocker.release();
      clientBlocker.release();
      commandOrderProbe.release();
    }
  });

  it('terminates an impossible waiter probe without leaking work onto a released session', async () => {
    const observer = await pool.connect();
    try {
      await expect(waitForLockWaiters(observer, 100, 'harness-cancellation', 50)).rejects.toThrow(
        'POSTGRES_TEST_TIMEOUT:harness-cancellation',
      );
      await expect(observer.query('select 1')).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      observer.release();
    }
  });
});
