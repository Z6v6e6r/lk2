import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  createMessagingModerationRepository,
  type MessagingModerationRepository,
} from './messaging-moderation-repository.js';
import { createMessagingRepository, type MessagingRepository } from './messaging-repository.js';

/**
 * Real PostgreSQL evidence for the report → case → action flow: the shared case per message, the
 * moderator decision that hides a message through the paired columns, and the readers that must stop
 * returning it.
 */
const suppliedConnectionString = process.env.MESSAGING_MODERATION_TEST_DATABASE_URL;
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const describePostgres = suppliedConnectionString || ciConnectionString ? describe : describe.skip;

describePostgres('chat message moderation PostgreSQL flow', () => {
  let pool: Pool;
  let moderation: MessagingModerationRepository;
  let messaging: MessagingRepository;
  const tenantId = randomUUID();
  const senderUserId = randomUUID();
  const reporterUserId = randomUUID();
  const moderatorUserId = randomUUID();
  const conversationId = randomUUID();
  const command = () => randomUUID().replaceAll('-', '').padEnd(32, '0').slice(0, 32);

  beforeAll(async () => {
    pool = new Pool({
      connectionString: suppliedConnectionString ?? ciConnectionString,
      max: 4,
      application_name: 'phub-messaging-moderation-pg-test',
    });
    moderation = createMessagingModerationRepository(pool);
    messaging = createMessagingRepository(pool);
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `moderation-pg-${tenantId}`, 'Chat moderation PostgreSQL'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      let index = 0;
      for (const id of [senderUserId, reporterUserId, moderatorUserId]) {
        index += 1;
        await client.query(
          `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
          [tenantId, id],
        );
        await client.query(
          `insert into identity.user_access_profiles (tenant_id, user_id, roles, permissions)
           values ($1, $2, array['client']::text[], array['chat.direct.create']::text[])`,
          [tenantId, id],
        );
        await client.query(
          `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
           values ($1, $2, $3, $4)`,
          [tenantId, id, `Moderation peer ${index}`, `+7900001${index}`],
        );
      }
      await client.query(
        `insert into messaging.tenant_runtime_settings (tenant_id, http_enabled, direct_enabled)
         values ($1, true, true)`,
        [tenantId],
      );
      const [leftUserId, rightUserId] = [senderUserId, reporterUserId].sort();
      await client.query(
        `insert into messaging.conversations (tenant_id, id, kind, state, next_sequence)
         values ($1, $2, 'DIRECT', 'OPEN', 2)`,
        [tenantId, conversationId],
      );
      await client.query(
        `insert into messaging.direct_conversations (tenant_id, conversation_id, left_user_id, right_user_id)
         values ($1, $2, $3, $4)`,
        [tenantId, conversationId, leftUserId, rightUserId],
      );
      await client.query(
        `insert into messaging.conversation_members (tenant_id, id, conversation_id, user_id, member_type, state)
         values ($1, $2, $3, $4, 'USER', 'ACTIVE')`,
        [tenantId, randomUUID(), conversationId, senderUserId],
      );
      await client.query(
        `insert into messaging.conversation_members (tenant_id, id, conversation_id, user_id, member_type, state)
         values ($1, $2, $3, $4, 'USER', 'ACTIVE')`,
        [tenantId, randomUUID(), conversationId, reporterUserId],
      );
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('runs report, case, hide and restore against a real database', async () => {
    const sent = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-moderation-${command()}`,
      idempotencyKey: `command-moderation-${command()}`,
      body: 'оскорбительное сообщение',
      correlationId: `correlation-moderation-${command()}`,
    });
    expect(sent.outcome).toBe('ok');
    if (sent.outcome !== 'ok') return;
    const reportedMessageId = sent.message.id;

    const first = await moderation.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId: reportedMessageId,
      reasonCode: 'ABUSE',
      details: 'грубость',
      idempotencyKey: `report-${command()}`,
      correlationId: `correlation-report-${command()}`,
    });
    expect(first).toMatchObject({ outcome: 'submitted', replayed: false });

    const queue = await moderation.listReportQueue({ tenantId, limit: 50 });
    const queued = queue.find(
      (item) => item.reportId === (first as { report: { id: string } }).report.id,
    );
    expect(queued).toMatchObject({
      messageId: reportedMessageId,
      messageBody: 'оскорбительное сообщение',
      reasonCode: 'ABUSE',
      caseState: 'OPEN',
    });

    const hidden = await moderation.decideReport({
      tenantId,
      moderatorUserId,
      reportId: (first as { report: { id: string } }).report.id,
      action: 'HIDE_MESSAGE',
      reasonCode: 'ABUSE',
      idempotencyKey: `decision-${command()}`,
      correlationId: `correlation-decision-${command()}`,
    });
    expect(hidden).toEqual({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: false,
    });

    const hiddenRow = await withTenantTransaction(pool, tenantId, (client) =>
      client.query<{ hidden_at: Date | null; hidden_by_action_id: string | null }>(
        `select hidden_at, hidden_by_action_id from messaging.messages
          where tenant_id = $1 and id = $2`,
        [tenantId, reportedMessageId],
      ),
    );
    expect(hiddenRow.rows[0]?.hidden_at).not.toBeNull();
    expect(hiddenRow.rows[0]?.hidden_by_action_id).not.toBeNull();

    const history = await messaging.listMessages({
      tenantId,
      userId: reporterUserId,
      conversationId,
      afterSequence: 0,
      limit: 50,
    });
    expect(history.outcome).toBe('ok');
    if (history.outcome !== 'ok') return;
    expect(history.page.messages.some((message) => message.id === reportedMessageId)).toBe(false);

    const restored = await moderation.decideReport({
      tenantId,
      moderatorUserId,
      reportId: (first as { report: { id: string } }).report.id,
      action: 'RESTORE_MESSAGE',
      reasonCode: 'ABUSE',
      idempotencyKey: `decision-${command()}`,
      correlationId: `correlation-decision-${command()}`,
    });
    expect(restored).toMatchObject({
      outcome: 'decided',
      action: 'RESTORE_MESSAGE',
      hidden: false,
    });

    const visible = await messaging.listMessages({
      tenantId,
      userId: reporterUserId,
      conversationId,
      afterSequence: 0,
      limit: 50,
    });
    expect(visible.outcome).toBe('ok');
    if (visible.outcome !== 'ok') return;
    expect(visible.page.messages.some((message) => message.id === reportedMessageId)).toBe(true);
  });

  it('keeps one case per message, refuses a self report and replays an exact retry', async () => {
    const sent = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-moderation-${command()}`,
      idempotencyKey: `command-moderation-${command()}`,
      body: 'второе сообщение',
      correlationId: `correlation-moderation-${command()}`,
    });
    expect(sent.outcome).toBe('ok');
    if (sent.outcome !== 'ok') return;
    const targetId = sent.message.id;

    const self = await moderation.submitReport({
      tenantId,
      reporterUserId: senderUserId,
      conversationId,
      messageId: targetId,
      reasonCode: 'SPAM',
      details: null,
      idempotencyKey: `report-${command()}`,
      correlationId: `correlation-report-${command()}`,
    });
    expect(self).toEqual({ outcome: 'self_report' });

    const key = `report-${command()}`;
    const first = await moderation.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId: targetId,
      reasonCode: 'SPAM',
      details: 'реклама',
      idempotencyKey: key,
      correlationId: `correlation-report-${command()}`,
    });
    expect(first).toMatchObject({ outcome: 'submitted', replayed: false });

    const retry = await moderation.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId: targetId,
      reasonCode: 'SPAM',
      details: 'реклама',
      idempotencyKey: key,
      correlationId: `correlation-report-${command()}`,
    });
    expect(retry).toMatchObject({ outcome: 'submitted', replayed: true });

    const changedDetails = await moderation.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId: targetId,
      reasonCode: 'SPAM',
      details: 'другое описание',
      idempotencyKey: key,
      correlationId: `correlation-report-${command()}`,
    });
    expect(changedDetails).toEqual({ outcome: 'duplicate' });

    // A different reason joins the same shared case instead of opening a new one.
    const secondReason = await moderation.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId: targetId,
      reasonCode: 'SCAM',
      details: null,
      idempotencyKey: `report-${command()}`,
      correlationId: `correlation-report-${command()}`,
    });
    expect(secondReason).toMatchObject({ outcome: 'submitted' });
    if (secondReason.outcome !== 'submitted' || first.outcome !== 'submitted') return;
    expect(secondReason.caseId).toBe(first.caseId);

    const cases = await withTenantTransaction(pool, tenantId, (client) =>
      client.query<{ count: string }>(
        `select count(*)::text as count from moderation.cases
          where tenant_id = $1 and dedupe_key = $2`,
        [tenantId, `chat-message:${targetId}`],
      ),
    );
    expect(cases.rows[0]?.count).toBe('1');
  });
});
