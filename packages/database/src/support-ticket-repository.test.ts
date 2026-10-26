import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createSupportTicketRepository,
  decodeSupportTicketCursor,
  SupportTicketPermissionError,
  type SupportTicketView,
} from './support-ticket-repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const ticketId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const date = '2026-10-11 12:00:00.123456+00';
const row = {
  id: ticketId,
  owner_user_id: userId,
  subject: 'Synthetic issue',
  category: 'TECHNICAL',
  status: 'OPEN',
  priority: 'NORMAL',
  assigned_to: null,
  tags: [],
  created_at: date,
  updated_at: date,
  resolved_at: null,
  auto_close_at: null,
  version: 1,
};
const command = {
  tenantId,
  ticketId,
  actorId: userId,
  expectedVersion: 1,
  body: 'Synthetic body',
  admin: false,
  idempotencyKey: 'synthetic-command-00001',
  requestHash: 'a'.repeat(64),
  correlationId: 'synthetic-correlation',
};
interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}
function fixture(answer?: (call: Call) => readonly unknown[] | undefined) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const call = { sql: sql.replace(/\s+/gu, ' ').trim(), values };
    calls.push(call);
    const supplied = await Promise.resolve(answer?.(call));
    if (supplied !== undefined) return { rows: supplied, rowCount: supplied.length };
    if (call.sql.includes('from identity.user_access_profiles'))
      return { rows: [{ user_id: agentId }], rowCount: 1 };
    if (call.sql.startsWith('select request_hash,result_json')) return { rows: [], rowCount: 0 };
    if (
      call.sql.includes('from support.tickets') ||
      call.sql.startsWith('insert into support.tickets')
    )
      return { rows: [row], rowCount: 1 };
    if (call.sql.startsWith('update support.tickets'))
      return { rows: [{ ...row, status: values[3] ?? 'CLOSED', version: 2 }], rowCount: 1 };
    if (call.sql.includes('from notifications.templates'))
      return { rows: [{ id: agentId }], rowCount: 1 };
    if (call.sql.startsWith('insert into notifications.intents'))
      return { rows: [{ id: userId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { repository: createSupportTicketRepository(pool), calls, release };
}

describe('support ticket transaction boundaries', () => {
  it('holds the owner-qualified read lock while hydrating metadata/messages/history from one aggregate version', async () => {
    const { repository, calls } = fixture();
    await repository.get({ tenantId, ticketId, ownerUserId: userId, admin: false });
    const ticketIndex = calls.findIndex((call) => call.sql.includes('from support.tickets'));
    expect(calls[ticketIndex]?.sql).toContain('owner_user_id=$3 and internal_only=false for share');
    expect(ticketIndex).toBeLessThan(
      calls.findIndex((call) => call.sql.includes('from support.messages')),
    );
    expect(calls.at(-1)?.sql).toBe('commit');
  });
  it('serializes an absent command key before receipt read and completes receipt after all aggregate effects', async () => {
    const { repository, calls, release } = fixture();
    const result = await repository.message(command);
    expect(result.outcome).toBe('applied');
    const sql = calls.map((call) => call.sql);
    expect(sql[0]).toBe('begin');
    expect(sql.at(-1)).toBe('commit');
    expect(release).toHaveBeenCalledOnce();
    expect(sql.findIndex((item) => item.includes('pg_advisory_xact_lock'))).toBeLessThan(
      sql.findIndex((item) => item.includes('from support.commands')),
    );
    expect(calls.find((call) => call.sql.includes('pg_advisory_xact_lock'))?.values).toEqual([
      JSON.stringify([tenantId, userId, command.idempotencyKey]),
    ]);
    expect(sql.find((item) => item.includes('from support.tickets'))).toContain(
      'owner_user_id=$3 and internal_only=false for update',
    );
    const receiptIndex = sql.findIndex((item) => item.startsWith('insert into support.commands'));
    for (const prefix of [
      'insert into support.messages',
      'insert into support.history',
      'insert into audit.audit_log',
      'insert into audit.outbox_events',
    ])
      expect(sql.findIndex((item) => item.startsWith(prefix))).toBeLessThan(receiptIndex);
    expect(
      calls.find((call) => call.sql.startsWith('insert into support.commands'))?.values[6],
    ).toContain('"version":2');
  });
  it('returns the stored result, even when the current ticket version has changed, without another effect', async () => {
    const stored = {
      id: ticketId,
      version: 1,
      subject: 'Original receipt',
      messages: [],
      history: [],
    } as unknown as SupportTicketView;
    const { repository, calls } = fixture(({ sql }) =>
      sql.includes('from support.commands')
        ? [{ ticket_id: ticketId, request_hash: command.requestHash, result_json: stored }]
        : sql.includes('from support.tickets')
          ? [{ ...row, version: 7 }]
          : undefined,
    );
    expect(await repository.message(command)).toEqual({
      outcome: 'applied',
      replayed: true,
      ticket: stored,
    });
    expect(calls.some((call) => /^(insert|update)/u.test(call.sql))).toBe(false);
    expect(calls.filter((call) => call.sql.includes('from support.tickets'))).toHaveLength(1);
  });
  it('rejects changed semantics under one key and hides an unowned ticket behind not_found', async () => {
    const old = fixture(({ sql }) =>
      sql.includes('from support.commands')
        ? [{ request_hash: 'b'.repeat(64), result_json: {} }]
        : undefined,
    );
    expect(await old.repository.message(command)).toEqual({ outcome: 'idempotency_conflict' });
    expect(old.calls.some((call) => call.sql.includes('from support.tickets'))).toBe(false);
    const unowned = fixture(({ sql }) => (sql.includes('from support.tickets') ? [] : undefined));
    expect(await unowned.repository.message(command)).toEqual({ outcome: 'not_found' });
    expect(unowned.calls.some((call) => /^(insert|update)/u.test(call.sql))).toBe(false);
  });
  it('rechecks ACTIVE admin grants before reading or replaying internal data', async () => {
    const { repository, calls } = fixture(({ sql }) =>
      sql.includes('from identity.user_access_profiles') ? [] : undefined,
    );
    await expect(
      repository.list({ tenantId, limit: 20, adminActorId: agentId }),
    ).rejects.toBeInstanceOf(SupportTicketPermissionError);
    await expect(
      repository.get({ tenantId, ticketId, admin: true, adminActorId: agentId }),
    ).rejects.toBeInstanceOf(SupportTicketPermissionError);
    expect(await repository.message({ ...command, actorId: agentId, admin: true })).toEqual({
      outcome: 'forbidden',
    });
    expect(
      calls.some(
        (call) =>
          call.sql.includes('from support.commands') || call.sql.includes('from support.tickets'),
      ),
    ).toBe(false);
    const authorization = calls.find((call) => call.sql.includes('user_access_profiles'))!.sql;
    expect(authorization).toContain("u.status='ACTIVE'");
    expect(authorization).toContain("'admin'=any(p.roles)");
    expect(authorization).toContain('for share of p,u');
    expect(authorization).toContain("'support.manage'=any(p.permissions)");
  });
  it('rolls back without receipt when notification materialization fails', async () => {
    const { repository, calls } = fixture(({ sql }) => {
      if (sql.startsWith('insert into notifications.inbox_items'))
        throw new Error('synthetic failure');
      return undefined;
    });
    await expect(repository.message({ ...command, actorId: agentId, admin: true })).rejects.toThrow(
      'synthetic failure',
    );
    expect(calls.at(-1)?.sql).toBe('rollback');
    expect(calls.some((call) => call.sql.startsWith('insert into support.commands'))).toBe(false);
  });
  it('writes notification intent before delivery/inbox with the same tenant-scoped references and no message text in audit', async () => {
    const { repository, calls } = fixture();
    await repository.message({ ...command, actorId: agentId, admin: true });
    const intentIndex = calls.findIndex((call) =>
      call.sql.startsWith('insert into notifications.intents'),
    );
    const deliveryIndex = calls.findIndex((call) =>
      call.sql.startsWith('insert into notifications.deliveries'),
    );
    const inboxIndex = calls.findIndex((call) =>
      call.sql.startsWith('insert into notifications.inbox_items'),
    );
    expect(intentIndex).toBeLessThan(deliveryIndex);
    expect(intentIndex).toBeLessThan(inboxIndex);
    expect(calls[deliveryIndex]?.values.slice(0, 2)).toEqual([tenantId, userId]);
    expect(calls[inboxIndex]?.values.slice(0, 3)).toEqual([tenantId, userId, userId]);
    for (const call of calls.filter(
      (call) =>
        call.sql.includes('insert into audit.') ||
        call.sql.startsWith('insert into notifications.'),
    ))
      expect(JSON.stringify(call.values)).not.toContain(command.body);
    expect(
      calls.find((call) => call.sql.startsWith('insert into notifications.templates'))?.sql,
    ).toContain('on conflict');
  });
  it('keeps notes internal, preserves resolved deadlines and excludes internal history in user reads', async () => {
    const { repository, calls } = fixture();
    await repository.message({ ...command, actorId: agentId, admin: true, internal: true });
    expect(calls.find((call) => call.sql.startsWith('update support.tickets'))?.values[4]).toBe(
      true,
    );
    expect(
      calls.find((call) => call.sql.startsWith('insert into support.history'))?.values[4],
    ).toBe(true);
    expect(calls.some((call) => call.sql.startsWith('insert into notifications.'))).toBe(false);
    calls.length = 0;
    await repository.get({ tenantId, ticketId, ownerUserId: userId, admin: false });
    expect(calls.find((call) => call.sql.includes('from support.messages'))?.sql).toContain(
      'internal=false',
    );
    expect(calls.find((call) => call.sql.includes('from support.history'))?.sql).toContain(
      'internal=false',
    );
  });
  it('rejects stale version and invalid assignee without a write and keeps metadata updates from extending 72h', async () => {
    const stale = fixture();
    expect(await stale.repository.message({ ...command, expectedVersion: 2 })).toEqual({
      outcome: 'version_conflict',
    });
    expect(stale.calls.some((call) => /^(insert|update)/u.test(call.sql))).toBe(false);
    const assignment = fixture(({ sql, values }) =>
      sql.includes('from identity.user_access_profiles') && values[1] === userId ? [] : undefined,
    );
    expect(
      await assignment.repository.update({ ...command, actorId: agentId, assignedTo: userId }),
    ).toEqual({ outcome: 'forbidden' });
    const metadata = fixture();
    await metadata.repository.update({ ...command, actorId: agentId, tags: ['synthetic'] });
    expect(
      metadata.calls.find((call) => call.sql.startsWith('update support.tickets'))?.sql,
    ).toContain("coalesce(auto_close_at,now()+interval '72 hours')");
  });
  it('uses microsecond timestamp and UUID for list/message pagination and chronological message output', async () => {
    const messages = Array.from({ length: 51 }, (_, index) => ({
      id: `${String(index).padStart(8, '0')}-3333-4333-8333-333333333333`,
      body: String(index),
      author_role: 'USER',
      internal: false,
      created_at: date,
    }));
    const { repository, calls } = fixture(({ sql }) =>
      sql.includes('from support.messages')
        ? messages
        : sql.includes('from support.tickets')
          ? [row, { ...row, id: agentId }]
          : undefined,
    );
    const list = await repository.list({ tenantId, ownerUserId: userId, limit: 1 });
    expect(decodeSupportTicketCursor(list.nextCursor!)!).toEqual({ at: date, id: ticketId });
    await repository.list({ tenantId, ownerUserId: userId, limit: 1, cursor: list.nextCursor! });
    expect(calls.at(-2)?.sql).toContain('(updated_at,id)<($3::timestamptz,$4::uuid)');
    const ticket = await repository.get({ tenantId, ticketId, admin: false, ownerUserId: userId });
    expect(ticket?.messages[0]?.body).toBe('49');
    expect(ticket?.messages.at(-1)?.body).toBe('0');
    expect(decodeSupportTicketCursor(ticket!.nextMessageCursor!)!).toEqual({
      at: date,
      id: messages[49]!.id,
    });
  });
  it('locks only overdue resolved rows and rechecks the same predicates before auto-close', async () => {
    const { repository, calls } = fixture();
    expect(
      await repository.closeResolvedBatch({ tenantId, limit: 10, correlationId: 'synthetic' }),
    ).toBe(1);
    expect(calls.find((call) => call.sql.startsWith('select id,owner_user_id'))?.sql).toContain(
      "status='RESOLVED' and auto_close_at<=now() order by auto_close_at,id limit $2 for update skip locked",
    );
    expect(calls.find((call) => call.sql.startsWith('update support.tickets'))?.sql).toContain(
      "status='RESOLVED' and auto_close_at<=now()",
    );
  });
});

describe('support privacy and durable resource bounds', () => {
  it('hides staff assignment/tags and never searches internal tags on owner reads', async () => {
    const { repository, calls } = fixture(({ sql }) =>
      sql.includes('from support.tickets')
        ? [{ ...row, assigned_to: agentId, tags: ['internal-triage'] }]
        : undefined,
    );
    const page = await repository.list({
      tenantId,
      ownerUserId: userId,
      limit: 20,
      query: 'internal-triage',
    });
    expect(page.items[0]).toMatchObject({ assignedTo: null, tags: [] });
    expect(calls.find((call) => call.sql.includes('from support.tickets'))?.sql).not.toContain(
      'unnest(tags)',
    );
    const ticket = await repository.get({ tenantId, ticketId, ownerUserId: userId, admin: false });
    expect(ticket).toMatchObject({ assignedTo: null, tags: [] });
  });
  it('stores body-free bounded command receipts and metadata audit deltas', async () => {
    const { repository, calls } = fixture();
    const result = await repository.update({ ...command, actorId: agentId, priority: 'HIGH' });
    expect(result.outcome === 'applied' && result.ticket.messages).toEqual([]);
    const receipt = calls.find((call) => call.sql.startsWith('insert into support.commands'))!;
    expect(String(receipt.values[6])).not.toContain(command.body);
    expect(String(receipt.values[6]).length).toBeLessThan(4096);
    expect(JSON.parse(String(receipt.values[6]))).toMatchObject({ messages: [], history: [] });
    const audit = calls.find((call) => call.sql.startsWith('insert into audit.audit_log'))!;
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({
      status: 'OPEN',
      priority: 'NORMAL',
      category: 'TECHNICAL',
      assignedTo: null,
      tagsCount: 0,
    });
    expect(JSON.parse(String(audit.values[6]))).toMatchObject({ ticketId });
  });
  it('rejects an exhausted actor window without writes but allows an exact replay regardless of quota', async () => {
    const limited = fixture(({ sql }) =>
      sql.includes('count(*)') && sql.includes('from support.commands')
        ? [{ count: 30 }]
        : undefined,
    );
    expect(await limited.repository.message(command)).toEqual({ outcome: 'rate_limited' });
    expect(limited.calls.some((call) => /^(insert|update)/u.test(call.sql))).toBe(false);
    const quota = limited.calls.find(
      (call) => call.sql.includes('count(*)') && call.sql.includes('from support.commands'),
    )!;
    expect(quota.values.slice(0, 2)).toEqual([tenantId, userId]);
    expect(quota.sql).toContain("completed_at>now()-interval '1 hour'");
    const replay = fixture(({ sql }) =>
      sql.startsWith('select request_hash,result_json')
        ? [
            {
              request_hash: command.requestHash,
              result_json: { id: ticketId, version: 1, messages: [], history: [] },
            },
          ]
        : undefined,
    );
    expect(await replay.repository.message(command)).toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    expect(replay.calls.some((call) => call.sql.includes('count(*)'))).toBe(false);
  });
  it('caps active user tickets and cumulative ticket messages', async () => {
    const tickets = fixture(({ sql }) =>
      sql.includes('count(*)') && sql.includes('from support.tickets')
        ? [{ count: 10 }]
        : undefined,
    );
    expect(
      await tickets.repository.create({
        tenantId,
        ownerUserId: userId,
        subject: 'Synthetic',
        category: 'TECHNICAL',
        body: 'Synthetic',
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        correlationId: 'synthetic',
      }),
    ).toEqual({ outcome: 'ticket_limit' });
    const messages = fixture(({ sql }) =>
      sql.includes('count(*)') && sql.includes('from support.messages')
        ? [{ count: 1000 }]
        : undefined,
    );
    expect(await messages.repository.message(command)).toEqual({ outcome: 'content_limit' });
    expect(messages.calls.some((call) => /^(insert|update)/u.test(call.sql))).toBe(false);
  });
});

describe('support audit tag minimization', () => {
  it('does not copy arbitrary staff tag text into audit, outbox or notifications', async () => {
    const sensitive = 'synthetic-private-tag@example.test';
    const { repository, calls } = fixture(({ sql }) =>
      sql.includes('from support.tickets') ? [{ ...row, tags: [sensitive] }] : undefined,
    );
    await repository.update({ ...command, actorId: agentId, tags: ['ordinary'] });
    for (const call of calls.filter(
      (call) =>
        call.sql.startsWith('insert into audit.') ||
        call.sql.startsWith('insert into notifications.'),
    ))
      expect(JSON.stringify(call.values)).not.toContain(sensitive);
  });
});

describe('support24-month retention', () => {
  it('locks/rechecks due CLOSED rows, purges all text copies and retires content-derived command hashes', async () => {
    const { repository, calls } = fixture();
    expect(
      await repository.purgeClosedBatch({ tenantId, limit: 10, correlationId: 'synthetic' }),
    ).toBe(1);
    const selection = calls.find((call) => call.sql.startsWith('select id from support.tickets'))!;
    expect(selection.sql).toContain("status='CLOSED' and closed_at<=now()-interval '24 months'");
    expect(selection.sql).toContain('for update skip locked');
    expect(calls.find((call) => call.sql.startsWith('update support.tickets'))?.sql).toContain(
      "subject='Обращение #'||id::text,tags='{}',assigned_to=null",
    );
    expect(
      calls.find((call) => call.sql.startsWith('delete from support.messages'))?.values,
    ).toEqual([tenantId, ticketId]);
    const receipt = calls.find((call) => call.sql.startsWith('update support.commands'))!;
    expect(receipt.sql).toContain('request_hash=null,retired_at=now()');
    expect(receipt.sql).not.toContain('subject');
    expect(receipt.sql).not.toContain('tags');
    expect(calls.some((call) => call.sql.startsWith('delete from support.history'))).toBe(false);
  });
  it('does nothing for non-due/reopened rows and never reexecutes an old retired key', async () => {
    const noDue = fixture(({ sql }) =>
      sql.startsWith('select id from support.tickets') ? [] : undefined,
    );
    expect(
      await noDue.repository.purgeClosedBatch({ tenantId, limit: 10, correlationId: 'synthetic' }),
    ).toBe(0);
    expect(noDue.calls.some((call) => /^(delete|update|insert)/u.test(call.sql))).toBe(false);
    const expired = fixture(({ sql }) =>
      sql.includes('from support.commands')
        ? [
            {
              ticket_id: ticketId,
              request_hash: null,
              result_json: { id: ticketId, messages: [], history: [] },
              retired_at: date,
            },
          ]
        : undefined,
    );
    expect(await expired.repository.message(command)).toEqual({ outcome: 'receipt_expired' });
    expect(expired.calls.some((call) => /^(delete|update|insert)/u.test(call.sql))).toBe(false);
    expect(expired.calls.filter((call) => call.sql.includes('from support.commands'))).toHaveLength(
      2,
    );
  });
  it('requires reopening a purged CLOSED ticket before adding text or staff tags', async () => {
    const purgedRow = { ...row, status: 'CLOSED', closed_at: date, conversation_purged_at: date };
    const archived = fixture(({ sql }) =>
      sql.includes('from support.tickets') ? [purgedRow] : undefined,
    );
    expect(
      await archived.repository.message({
        ...command,
        actorId: agentId,
        admin: true,
        internal: true,
      }),
    ).toEqual({ outcome: 'conversation_archived' });
    expect(
      await archived.repository.update({ ...command, actorId: agentId, tags: ['private'] }),
    ).toEqual({ outcome: 'conversation_archived' });
    expect(archived.calls.some((call) => /^(delete|update|insert)/u.test(call.sql))).toBe(false);
    expect(
      await archived.repository.message({ ...command, expectedVersion: 1, body: 'New reply' }),
    ).toMatchObject({ outcome: 'applied', ticket: { status: 'OPEN' } });
  });
});
