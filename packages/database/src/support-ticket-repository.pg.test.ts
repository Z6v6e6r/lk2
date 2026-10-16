import { supportRuntimePrerequisiteGrantStatements } from './support-ticket-prerequisites.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertMigrationLedgerCompatible } from './migration-ledger-policy.js';
import {
  assertSupportTicketAclBoundary,
  inspectSupportTicketAclBoundary,
  supportTicketRuntimeGrantStatements,
} from './support-ticket-acl.js';
import {
  createSupportTicketRepository,
  type SupportMutationResult,
  type SupportTicketView,
  SupportTicketPermissionError,
} from './support-ticket-repository.js';
import { withTenantTransaction } from './connection.js';

const connectionString = process.env.SUPPORT_TICKET_PG_VERIFY_URL;
const runtimeRoleName = process.env.SUPPORT_TICKET_PG_RUNTIME_ROLE;
const describeDatabase = connectionString ? describe.sequential : describe.skip;
const execFileAsync = promisify(execFile);
function assertFixtureAuthority(url: string, runtime: string | undefined): void {
  const parsed = new URL(url);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.search ||
    parsed.hash ||
    !/^[a-z0-9_]+_support_verify$/u.test(parsed.pathname.slice(1))
  )
    throw new Error('SUPPORT_PG_FIXTURE_TARGET_INVALID');
  if (
    process.env.SUPPORT_TICKET_PG_WRITES !== 'AUTHORIZED' ||
    !runtime ||
    !/^support_fixture_[a-z0-9_]+$/u.test(runtime)
  )
    throw new Error('SUPPORT_PG_FIXTURE_AUTHORITY_REQUIRED');
}
function applied(result: SupportMutationResult): SupportTicketView {
  if (result.outcome !== 'applied')
    throw new Error(`SUPPORT_FIXTURE_EXPECTED_APPLIED:${result.outcome}`);
  return result.ticket;
}
describe('support PostgreSQL fixture guard', () => {
  it('rejects remote/shared/option-bearing targets before any connection', () => {
    for (const url of [
      'postgresql://fixture@remote.example/padl_support_verify',
      'postgresql://fixture@localhost/padlhub',
      'postgresql://fixture@localhost/padl_support_verify?host=remote.example',
    ])
      expect(() => assertFixtureAuthority(url, 'support_fixture_test')).toThrow(
        'SUPPORT_PG_FIXTURE_TARGET_INVALID',
      );
  });
});
/** The caller provisions the fresh disposable database and runtime role separately. This fixture does not create/drop either. */
describeDatabase('support physical transaction/RLS verification', () => {
  let owner: Pool;
  let runtime: Pool;
  let repository: ReturnType<typeof createSupportTicketRepository>;
  let ownerRoleName: string;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const agent = randomUUID();
  beforeAll(async () => {
    assertFixtureAuthority(connectionString!, runtimeRoleName);
    owner = new Pool({ connectionString, max: 8 });
    const target = await owner.query<{ database: string; role: string }>(
      'select current_database() as database,current_user as role',
    );
    if (!target.rows[0]?.database.endsWith('_support_verify'))
      throw new Error('SUPPORT_PG_FIXTURE_WIRE_TARGET_INVALID');
    ownerRoleName = target.rows[0].role;
    // Same immutable migrator process twice proves additive apply and ledger-safe reapply. URL is synthetic, never logged.
    const migrationEnv = {
      ...process.env,
      DATABASE_URL: connectionString!,
      // Canonical migrator verifies the empty catalog; this never grants shared maintenance mode.
      CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
    };
    await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: migrationEnv,
      maxBuffer: 2_000_000,
    });
    const before = await owner.query(
      'select filename,checksum from public.schema_migrations order by filename',
    );
    await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: migrationEnv,
      maxBuffer: 2_000_000,
    });
    const after = await owner.query(
      'select filename,checksum from public.schema_migrations order by filename',
    );
    expect(after.rows).toEqual(before.rows);
    const files = (await readdir(resolve(import.meta.dirname, '../migrations')))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assertMigrationLedgerCompatible({
      applied: after.rows,
      packaged: await Promise.all(
        files.map(async (filename) => ({
          filename,
          checksum: createHash('sha256')
            .update(await readFile(resolve(import.meta.dirname, '../migrations', filename)))
            .digest('hex'),
        })),
      ),
    });
    const grantClient = await owner.connect();
    try {
      await grantClient.query('begin');
      for (const statement of supportTicketRuntimeGrantStatements(runtimeRoleName!))
        await grantClient.query(statement);
      for (const statement of supportRuntimePrerequisiteGrantStatements(runtimeRoleName!))
        await grantClient.query(statement);
      assertSupportTicketAclBoundary(
        await inspectSupportTicketAclBoundary(grantClient, runtimeRoleName!, ownerRoleName),
        { runtimeRoleName: runtimeRoleName!, migratorRoleName: ownerRoleName },
      );
      await grantClient.query('commit');
    } catch (error) {
      await grantClient.query('rollback');
      throw error;
    } finally {
      grantClient.release();
    }
    const runtimeUrl = new URL(connectionString!);
    runtimeUrl.username = runtimeRoleName!;
    runtimeUrl.password = process.env.SUPPORT_TICKET_PG_RUNTIME_PASSWORD ?? '';
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 8 });
    const wire = await runtime.query<{ current_role: string; session_role: string }>(
      'select current_user as current_role,session_user as session_role',
    );
    expect(wire.rows[0]).toEqual({
      current_role: runtimeRoleName!,
      session_role: runtimeRoleName!,
    });
    repository = createSupportTicketRepository(runtime);
    await owner.query(
      'insert into identity.tenants(id,tenant_key,display_name) values($1,$2,$3),($4,$5,$6)',
      [
        tenantA,
        `support-a-${tenantA}`,
        'Synthetic A',
        tenantB,
        `support-b-${tenantB}`,
        'Synthetic B',
      ],
    );
    await owner.query(
      "insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE'),($3,$4,'ACTIVE'),($1,$5,'ACTIVE')",
      [tenantA, userA, tenantB, userB, agent],
    );
    await owner.query(
      "insert into identity.user_access_profiles(tenant_id,user_id,roles,permissions) values($1,$2,array['admin'],array['support.manage'])",
      [tenantA, agent],
    );
  }, 120_000);
  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
  });
  const createInput = (key = randomUUID()) => ({
    tenantId: tenantA,
    ownerUserId: userA,
    subject: 'Synthetic issue',
    category: 'TECHNICAL' as const,
    body: 'Synthetic first message',
    idempotencyKey: key,
    requestHash: 'a'.repeat(64),
    correlationId: randomUUID(),
  });
  it('proves same-key concurrency produces one aggregate and exact compact replay, changed semantics conflict', async () => {
    const input = createInput();
    const results = await Promise.all([repository.create(input), repository.create(input)]);
    expect(
      results.filter((result) => result.outcome === 'applied' && result.replayed),
    ).toHaveLength(1);
    const view = applied(results[0]);
    expect(applied(results[1])).toEqual(view);
    expect(view.messages).toEqual([]);
    const counts = await owner.query<{ count: number }>(
      'select count(*)::int as count from support.messages where tenant_id=$1 and ticket_id=$2',
      [tenantA, view.id],
    );
    expect(counts.rows[0]?.count).toBe(1);
    applied(
      await repository.message({
        tenantId: tenantA,
        ticketId: view.id,
        actorId: userA,
        expectedVersion: view.version,
        body: 'Synthetic follow-up',
        admin: false,
        idempotencyKey: randomUUID(),
        requestHash: 'f'.repeat(64),
        correlationId: randomUUID(),
      }),
    );
    expect(applied(await repository.create(input))).toEqual(view);
    expect(
      await repository.create({ ...input, requestHash: 'b'.repeat(64), body: 'Changed' }),
    ).toEqual({ outcome: 'idempotency_conflict' });
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query(
          "insert into support.commands(tenant_id,actor_id,idempotency_key,request_hash,ticket_id,result_version,result_json,command_kind) select tenant_id,actor_id,'invalid-receipt-fixture',request_hash,ticket_id,result_version,jsonb_set(result_json,'{messages}','[{}]'::jsonb),command_kind from support.commands where tenant_id=$1 limit 1",
          [tenantA],
        ),
      ),
    ).rejects.toThrow();
  });
  it('enforces missing-context and cross-tenant SELECT/INSERT/UPDATE and append-only runtime grants', async () => {
    const view = applied(await repository.create(createInput()));
    expect((await runtime.query('select id from support.tickets')).rows).toEqual([]);
    expect(
      (
        await withTenantTransaction(runtime, tenantB, (client) =>
          client.query('select id from support.tickets where id=$1', [view.id]),
        )
      ).rows,
    ).toEqual([]);
    expect(
      await repository.get({
        tenantId: tenantA,
        ticketId: view.id,
        ownerUserId: userB,
        admin: false,
      }),
    ).toBeUndefined();
    await expect(
      withTenantTransaction(runtime, tenantB, (client) =>
        client.query(
          "insert into support.messages(tenant_id,ticket_id,body,author_id,author_role) values($1,$2,'synthetic',$3,'USER')",
          [tenantA, view.id, userA],
        ),
      ),
    ).rejects.toThrow();
    expect(
      (
        await withTenantTransaction(runtime, tenantB, (client) =>
          client.query("update support.tickets set status='IN_PROGRESS' where id=$1", [view.id]),
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query('delete from support.messages where tenant_id=$1', [tenantA]),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query("update support.messages set body='mutated' where tenant_id=$1", [tenantA]),
      ),
    ).rejects.toThrow();
  });
  it('does not leak internal notes or staff labels and denies a freshly revoked admin replay/read', async () => {
    const view = applied(await repository.create(createInput()));
    const key = randomUUID();
    const note = {
      tenantId: tenantA,
      ticketId: view.id,
      actorId: agent,
      expectedVersion: view.version,
      body: 'Synthetic private note',
      admin: true,
      internal: true,
      idempotencyKey: key,
      requestHash: 'c'.repeat(64),
      correlationId: randomUUID(),
    };
    applied(await repository.message(note));
    const userView = await repository.get({
      tenantId: tenantA,
      ticketId: view.id,
      ownerUserId: userA,
      admin: false,
    });
    expect(userView?.messages.some((message) => message.internal)).toBe(false);
    expect(userView?.history.some((event) => event.kind.includes('internal_note'))).toBe(false);
    expect(
      (
        await repository.get({
          tenantId: tenantA,
          ticketId: view.id,
          admin: true,
          adminActorId: agent,
        })
      )?.messages.some((message) => message.internal),
    ).toBe(true);
    const inbox = await owner.query<{ count: number }>(
      'select count(*)::int as count from notifications.inbox_items where tenant_id=$1 and deep_link=$2',
      [tenantA, `/support/${view.id}`],
    );
    expect(inbox.rows[0]?.count).toBe(0);
    await owner.query(
      "update identity.user_access_profiles set permissions='{}' where tenant_id=$1 and user_id=$2",
      [tenantA, agent],
    );
    expect(await repository.message(note)).toEqual({ outcome: 'forbidden' });
    await expect(
      repository.list({ tenantId: tenantA, adminActorId: agent, limit: 20 }),
    ).rejects.toBeInstanceOf(SupportTicketPermissionError);
    await owner.query(
      "update identity.user_access_profiles set permissions=array['support.manage'] where tenant_id=$1 and user_id=$2",
      [tenantA, agent],
    );
  });
  it('preserves72h, reopens after auto-close and commits notification FK references atomically', async () => {
    const initial = applied(await repository.create(createInput()));
    const update = {
      tenantId: tenantA,
      ticketId: initial.id,
      actorId: agent,
      expectedVersion: initial.version,
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
      correlationId: randomUUID(),
      status: 'RESOLVED' as const,
    };
    const resolvedTicket = applied(await repository.update(update));
    const metadata = applied(
      await repository.update({
        ...update,
        expectedVersion: resolvedTicket.version,
        idempotencyKey: randomUUID(),
        requestHash: 'e'.repeat(64),
        priority: 'HIGH',
      }),
    );
    expect(metadata.autoCloseAt).toBe(resolvedTicket.autoCloseAt);
    expect(
      await repository.closeResolvedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(0);
    await owner.query(
      "update support.tickets set auto_close_at=now()-interval '1 second' where tenant_id=$1 and id=$2",
      [tenantA, initial.id],
    );
    expect(
      await repository.closeResolvedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(1);
    const reply = {
      tenantId: tenantA,
      ticketId: initial.id,
      actorId: userA,
      body: 'Synthetic reopen',
      expectedVersion: metadata.version,
      admin: false,
      idempotencyKey: randomUUID(),
      requestHash: 'f'.repeat(64),
      correlationId: randomUUID(),
    };
    expect(await repository.message(reply)).toEqual({ outcome: 'version_conflict' });
    const current = await repository.get({
      tenantId: tenantA,
      ticketId: initial.id,
      ownerUserId: userA,
      admin: false,
    });
    const reopened = applied(
      await repository.message({ ...reply, expectedVersion: current!.version }),
    );
    expect(reopened.status).toBe('OPEN');
    expect(reopened.autoCloseAt).toBeNull();
    const notifications = await owner.query<{ count: number }>(
      `select count(*)::int as count from notifications.inbox_items i join notifications.intents n on n.tenant_id=i.tenant_id and n.id=i.intent_id join notifications.deliveries d on d.tenant_id=n.tenant_id and d.intent_id=n.id where i.tenant_id=$1 and i.user_id=$2 and i.deep_link=$3 and d.channel='IN_APP' and d.state='DELIVERED'`,
      [tenantA, userA, `/support/${initial.id}`],
    );
    expect(notifications.rows[0]!.count).toBe(2);
  });
  it('serializes per-actor new-ticket quota across different concurrent keys', async () => {
    const actor = randomUUID();
    await owner.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
      tenantA,
      actor,
    ]);
    const results = await Promise.all(
      Array.from({ length: 7 }, () => repository.create({ ...createInput(), ownerUserId: actor })),
    );
    expect(results.filter((result) => result.outcome === 'applied')).toHaveLength(5);
    expect(results.filter((result) => result.outcome === 'rate_limited')).toHaveLength(2);
  });
  it('serializes a due close and user reply in both directions and never closes a reopened ticket', async () => {
    const initial = applied(await repository.create(createInput()));
    const resolvedTicket = applied(
      await repository.update({
        tenantId: tenantA,
        ticketId: initial.id,
        actorId: agent,
        expectedVersion: initial.version,
        idempotencyKey: randomUUID(),
        requestHash: 'd'.repeat(64),
        correlationId: randomUUID(),
        status: 'RESOLVED',
      }),
    );
    await owner.query(
      "update support.tickets set auto_close_at=now()-interval '1 second' where tenant_id=$1 and id=$2",
      [tenantA, initial.id],
    );
    const [closeCount, reply] = await Promise.all([
      repository.closeResolvedBatch({ tenantId: tenantA, limit: 100, correlationId: randomUUID() }),
      repository.message({
        tenantId: tenantA,
        ticketId: initial.id,
        actorId: userA,
        body: 'Synthetic race',
        expectedVersion: resolvedTicket.version,
        admin: false,
        idempotencyKey: randomUUID(),
        requestHash: 'f'.repeat(64),
        correlationId: randomUUID(),
      }),
    ]);
    const fresh = await repository.get({
      tenantId: tenantA,
      ticketId: initial.id,
      ownerUserId: userA,
      admin: false,
    });
    if (reply.outcome === 'applied') {
      expect(closeCount).toBe(0);
      expect(fresh?.status).toBe('OPEN');
    } else {
      expect(reply.outcome).toBe('version_conflict');
      expect(closeCount).toBe(1);
      expect(fresh?.status).toBe('CLOSED');
    }
    expect(
      await repository.closeResolvedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(0);
  });

  // Only the separately authorized, owned synthetic fixture ages its rows. Guard is re-enabled before commit.
  async function ageClosedTicket(ticketId: string): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(
        'alter table support.tickets disable trigger support_ticket_lifecycle_guard',
      );
      await client.query(
        "update support.tickets set closed_at=now()-interval '25 months' where tenant_id=$1 and id=$2 and status='CLOSED'",
        [tenantA, ticketId],
      );
      await client.query(
        'alter table support.tickets enable trigger support_ticket_lifecycle_guard',
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async function closedRetentionFixture() {
    const actor = randomUUID();
    await owner.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
      tenantA,
      actor,
    ]);
    const sensitive = `synthetic-retention-${randomUUID()}@example.test`;
    const input = {
      ...createInput(),
      ownerUserId: actor,
      subject: sensitive,
      body: `Conversation ${sensitive}`,
      requestHash: createHash('sha256').update(sensitive).digest('hex'),
    };
    const created = applied(await repository.create(input));
    const update = {
      tenantId: tenantA,
      ticketId: created.id,
      actorId: agent,
      expectedVersion: created.version,
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(`tag:${sensitive}`).digest('hex'),
      correlationId: randomUUID(),
      status: 'CLOSED' as const,
      tags: [sensitive],
      assignedTo: agent,
    };
    const closed = applied(await repository.update(update));
    return { actor, sensitive, input, update, closed };
  }
  function instrumentRuntime(
    afterQuery: (sql: string, rows: readonly QueryResultRow[]) => Promise<void>,
  ): Pool {
    return {
      connect: async () => {
        const client = await runtime.connect();
        return {
          query: async (sql: string, values?: readonly unknown[]) => {
            const result = await client.query<QueryResultRow>(
              sql,
              values ? [...values] : undefined,
            );
            await afterQuery(sql, result.rows);
            return result;
          },
          release: () => client.release(),
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
  }
  it('enforces retention guards against early deletion, forged close dates, receipt mutation and marker-only cleanup', async () => {
    const fixture = await closedRetentionFixture();
    for (const table of ['tickets', 'messages', 'history', 'commands']) {
      expect((await runtime.query(`select * from support.${table}`)).rows).toEqual([]);
      expect(
        (
          await withTenantTransaction(runtime, tenantB, (client) =>
            client.query(`select * from support.${table} where tenant_id=$1`, [tenantA]),
          )
        ).rows,
      ).toEqual([]);
    }
    for (const sql of [
      'delete from support.messages where tenant_id=$1 and ticket_id=$2',
      "update support.commands set request_hash=repeat('b',64) where tenant_id=$1 and ticket_id=$2",
    ]) {
      expect((await runtime.query(sql, [tenantA, fixture.closed.id])).rowCount).toBe(0);
      expect(
        (
          await withTenantTransaction(runtime, tenantB, (client) =>
            client.query(sql, [tenantA, fixture.closed.id]),
          )
        ).rowCount,
      ).toBe(0);
    }
    for (const [sql, values] of [
      [
        'delete from support.messages where tenant_id=$1 and ticket_id=$2',
        [tenantA, fixture.closed.id],
      ],
      [
        "update support.tickets set closed_at=now()-interval '25 months' where tenant_id=$1 and id=$2",
        [tenantA, fixture.closed.id],
      ],
      [
        "update support.commands set request_hash=repeat('b',64) where tenant_id=$1 and ticket_id=$2",
        [tenantA, fixture.closed.id],
      ],
    ] as const)
      await expect(
        withTenantTransaction(runtime, tenantA, (client) => client.query(sql, [...values])),
      ).rejects.toThrow();
    expect(
      await repository.purgeClosedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(0);
    await ageClosedTicket(fixture.closed.id);
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query(
          "update support.tickets set subject='Обращение #'||id::text,tags='{}',assigned_to=null,conversation_purged_at=now() where tenant_id=$1 and id=$2",
          [tenantA, fixture.closed.id],
        ),
      ),
    ).rejects.toThrow('SUPPORT_PURGE_MARKER_FORBIDDEN');
    expect(
      (
        await owner.query('select id from support.messages where tenant_id=$1 and ticket_id=$2', [
          tenantA,
          fixture.closed.id,
        ])
      ).rowCount,
    ).toBe(1);
    // This due row stays eligible despite the failed marker-only attempt.
    expect(
      await repository.purgeClosedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(1);
  });
  it('removes all conversation/text/hash copies after24months, retains metadata and forbids archived notes/tags until reopening', async () => {
    const fixture = await closedRetentionFixture();
    await ageClosedTicket(fixture.closed.id);
    expect(
      await repository.purgeClosedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(1);
    const snapshots = await Promise.all(
      [
        'support.tickets',
        'support.messages',
        'support.commands',
        'support.history',
        'audit.audit_log',
        'audit.outbox_events',
        'notifications.intents',
        'notifications.inbox_items',
      ].map((table) =>
        owner.query<{ record: unknown }>(
          `select to_jsonb(t) as record from ${table} t where tenant_id=$1`,
          [tenantA],
        ),
      ),
    );
    const retained = JSON.stringify(snapshots.map((result) => result.rows));
    expect(retained).not.toContain(fixture.sensitive);
    expect(retained).not.toContain(fixture.input.requestHash);
    expect(retained).not.toContain(fixture.update.requestHash);
    const current = await repository.get({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      ownerUserId: fixture.actor,
      admin: false,
    });
    expect(current).toMatchObject({
      id: fixture.closed.id,
      category: 'TECHNICAL',
      status: 'CLOSED',
      subject: `Обращение #${fixture.closed.id}`,
      messages: [],
      tags: [],
      assignedTo: null,
    });
    expect(current?.conversationPurgedAt).toBeTruthy();
    expect(
      current?.history.some((event) => event.kind === 'support.ticket.conversation_purged.v1'),
    ).toBe(true);
    expect(await repository.create({ ...fixture.input, body: 'Another body' })).toEqual({
      outcome: 'receipt_expired',
    });
    expect(await repository.update({ ...fixture.update, tags: ['another'] })).toEqual({
      outcome: 'receipt_expired',
    });
    const note = {
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      actorId: agent,
      expectedVersion: current!.version,
      body: 'New private text',
      admin: true,
      internal: true,
      idempotencyKey: randomUUID(),
      requestHash: 'b'.repeat(64),
      correlationId: randomUUID(),
    };
    expect(await repository.message(note)).toEqual({ outcome: 'conversation_archived' });
    expect(
      await repository.update({
        ...fixture.update,
        expectedVersion: current!.version,
        idempotencyKey: randomUUID(),
        requestHash: 'b'.repeat(64),
        tags: ['new private tag'],
      }),
    ).toEqual({ outcome: 'conversation_archived' });
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query(
          "insert into support.messages(tenant_id,ticket_id,body,author_id,author_role,internal) values($1,$2,'new private text',$3,'AGENT',true)",
          [tenantA, fixture.closed.id, agent],
        ),
      ),
    ).rejects.toThrow('SUPPORT_CONVERSATION_ARCHIVED');
    await expect(
      withTenantTransaction(runtime, tenantA, (client) =>
        client.query(
          "update support.tickets set tags=array['new private tag'] where tenant_id=$1 and id=$2",
          [tenantA, fixture.closed.id],
        ),
      ),
    ).rejects.toThrow('SUPPORT_CONVERSATION_ARCHIVED');
    const reopened = applied(
      await repository.message({
        ...note,
        actorId: fixture.actor,
        admin: false,
        internal: false,
        idempotencyKey: randomUUID(),
        requestHash: 'c'.repeat(64),
        body: 'New public question',
      }),
    );
    expect(reopened.status).toBe('OPEN');
    expect(reopened.closedAt).toBeNull();
    expect(reopened.conversationPurgedAt).toBe(current?.conversationPurgedAt);
    const reclosed = applied(
      await repository.update({
        ...fixture.update,
        expectedVersion: reopened.version,
        idempotencyKey: randomUUID(),
        requestHash: 'd'.repeat(64),
        tags: [],
        assignedTo: null,
      }),
    );
    expect(Date.parse(reclosed.closedAt!)).toBeGreaterThan(Date.parse(current!.closedAt!));
    expect(
      await repository.purgeClosedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(0);
    expect(
      (
        await repository.get({
          tenantId: tenantA,
          ticketId: fixture.closed.id,
          ownerUserId: fixture.actor,
          admin: false,
        })
      )?.messages.map((message) => message.body),
    ).toEqual(['New public question']);
  });
  it('rechecks a replay after waiting on a concurrent purge, with no pre-purge text response or repeated effect', async () => {
    const fixture = await closedRetentionFixture();
    await ageClosedTicket(fixture.closed.id);
    let purgeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      purgeEntered = resolve;
    });
    let resumePurge!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumePurge = resolve;
    });
    let replayRead!: () => void;
    const observed = new Promise<void>((resolve) => {
      replayRead = resolve;
    });
    let paused = false;
    const purger = createSupportTicketRepository(
      instrumentRuntime(async (sql) => {
        if (!paused && sql.startsWith('update support.commands')) {
          paused = true;
          purgeEntered();
          await resume;
        }
      }),
    );
    const replayer = createSupportTicketRepository(
      instrumentRuntime((sql, rows) => {
        if (sql.startsWith('select request_hash,result_json') && rows[0]?.retired_at === null) {
          replayRead();
        }
        return Promise.resolve();
      }),
    );
    const purge = purger.purgeClosedBatch({
      tenantId: tenantA,
      limit: 100,
      correlationId: randomUUID(),
    });
    await entered;
    const replay = replayer.create(fixture.input);
    const reply = repository.message({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      actorId: fixture.actor,
      expectedVersion: fixture.closed.version,
      body: 'Concurrent public reply',
      admin: false,
      idempotencyKey: randomUUID(),
      requestHash: 'e'.repeat(64),
      correlationId: randomUUID(),
    });
    try {
      await observed;
    } finally {
      resumePurge();
    }
    expect(await purge).toBe(1);
    expect(await replay).toEqual({ outcome: 'receipt_expired' });
    expect(await reply).toEqual({ outcome: 'version_conflict' });
    expect(
      (
        await owner.query('select id from support.messages where tenant_id=$1 and ticket_id=$2', [
          tenantA,
          fixture.closed.id,
        ])
      ).rowCount,
    ).toBe(0);
  }, 15_000);
  it('does not purge a reply that reopened the ticket while the worker scanned due rows', async () => {
    const fixture = await closedRetentionFixture();
    await ageClosedTicket(fixture.closed.id);
    let replyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      replyEntered = resolve;
    });
    let resumeReply!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeReply = resolve;
    });
    const replier = createSupportTicketRepository(
      instrumentRuntime(async (sql) => {
        if (sql.startsWith('update support.tickets')) {
          replyEntered();
          await resume;
        }
      }),
    );
    const reply = replier.message({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      actorId: fixture.actor,
      expectedVersion: fixture.closed.version,
      body: 'Reopened before purge',
      admin: false,
      idempotencyKey: randomUUID(),
      requestHash: 'e'.repeat(64),
      correlationId: randomUUID(),
    });
    await entered;
    try {
      expect(
        await repository.purgeClosedBatch({
          tenantId: tenantA,
          limit: 100,
          correlationId: randomUUID(),
        }),
      ).toBe(0);
    } finally {
      resumeReply();
    }
    expect(applied(await reply).status).toBe('OPEN');
    const fresh = await repository.get({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      ownerUserId: fixture.actor,
      admin: false,
    });
    expect(fresh?.closedAt).toBeNull();
    expect(fresh?.conversationPurgedAt).toBeNull();
    expect(fresh?.messages).toHaveLength(2);
  }, 15_000);

  it('keeps GET entirely before or after purge while holding its owner-qualified shared lock', async () => {
    const fixture = await closedRetentionFixture();
    await ageClosedTicket(fixture.closed.id);
    let readEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    let resumeRead!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    let paused = false;
    const reader = createSupportTicketRepository(
      instrumentRuntime(async (sql) => {
        if (!paused && sql.includes('from support.tickets') && sql.endsWith('for share')) {
          paused = true;
          readEntered();
          await resume;
        }
      }),
    );
    const reading = reader.get({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      ownerUserId: fixture.actor,
      admin: false,
    });
    await entered;
    try {
      expect(
        await repository.purgeClosedBatch({
          tenantId: tenantA,
          limit: 100,
          correlationId: randomUUID(),
        }),
      ).toBe(0);
    } finally {
      resumeRead();
    }
    const before = await reading;
    expect(before?.subject).toBe(fixture.sensitive);
    expect(before?.messages).toHaveLength(1);
    expect(before?.conversationPurgedAt).toBeNull();
    expect(
      await repository.purgeClosedBatch({
        tenantId: tenantA,
        limit: 100,
        correlationId: randomUUID(),
      }),
    ).toBe(1);
    const after = await repository.get({
      tenantId: tenantA,
      ticketId: fixture.closed.id,
      ownerUserId: fixture.actor,
      admin: false,
    });
    expect(after?.subject).toBe(`Обращение #${fixture.closed.id}`);
    expect(after?.messages).toEqual([]);
    expect(after?.conversationPurgedAt).toBeTruthy();
  }, 15_000);
});
