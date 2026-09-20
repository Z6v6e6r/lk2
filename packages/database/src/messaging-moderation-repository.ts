import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

/**
 * Chat message reporting and the CUP "hide on report" decision, slice 1.
 *
 * The schema already exists (`moderation.reports`, `moderation.cases`, `moderation.actions` and
 * `messaging.messages.hidden_at`). This repository owns only those rows; it never calls into
 * `messaging-repository.ts` and never reads the tenant runtime settings.
 */

/** The only reason codes a player may submit; the column regex accepts this shape. */
export const MESSAGING_REPORT_REASON_CODES = ['SPAM', 'ABUSE', 'SCAM', 'OTHER'] as const;

export type MessagingReportReasonCode = (typeof MESSAGING_REPORT_REASON_CODES)[number];

export type MessagingReportState = 'SUBMITTED' | 'TRIAGED' | 'DISMISSED';

export type MessagingModerationAction = 'HIDE_MESSAGE' | 'RESTORE_MESSAGE' | 'DISMISS';

/** `source` and `severity` values accepted by `moderation.cases` check constraints. */
const REPORT_CASE_SOURCE = 'USER_REPORT';
const REPORT_CASE_SEVERITY = 'MEDIUM';

export interface MessagingReportRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly reporterUserId: string;
  readonly reasonCode: string;
  readonly details: string | null;
  readonly state: MessagingReportState;
  readonly caseId: string | null;
  readonly createdAt: string;
}

export interface MessagingReportQueueItem {
  readonly reportId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageSenderUserId: string | null;
  readonly messageBody: string | null;
  readonly messageCreatedAt: string;
  readonly messageHiddenAt: string | null;
  readonly reporterUserId: string;
  readonly reasonCode: string;
  readonly details: string | null;
  readonly reportState: MessagingReportState;
  readonly caseId: string | null;
  readonly caseState: string | null;
  readonly caseSeverity: string | null;
  readonly createdAt: string;
}

export type MessagingReportSubmitResult =
  | {
      readonly outcome: 'submitted';
      readonly report: MessagingReportRecord;
      readonly caseId: string;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'self_report' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'idempotency_conflict' };

export type MessagingReportDecisionResult =
  | {
      readonly outcome: 'decided';
      readonly action: MessagingModerationAction;
      readonly hidden: boolean;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' };

export interface MessagingModerationRepository {
  submitReport(input: {
    readonly tenantId: string;
    readonly reporterUserId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly reasonCode: string;
    readonly details: string | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<MessagingReportSubmitResult>;
  listReportQueue(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly afterId?: string;
  }): Promise<readonly MessagingReportQueueItem[]>;
  decideReport(input: {
    readonly tenantId: string;
    readonly moderatorUserId: string;
    readonly reportId: string;
    readonly action: MessagingModerationAction;
    readonly reasonCode: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<MessagingReportDecisionResult>;
}

const REPORT_COLUMNS = `id, conversation_id, message_id, reporter_user_id, reason_code,
       details, state, case_id, created_at`;

interface ReportRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly reporter_user_id: string;
  readonly reason_code: string;
  readonly details: string | null;
  readonly state: MessagingReportState;
  readonly case_id: string | null;
  readonly created_at: Date | string;
}

interface ReportQueueRow extends QueryResultRow {
  readonly report_id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly message_sender_user_id: string | null;
  readonly message_body: string | null;
  readonly message_created_at: Date | string;
  readonly message_hidden_at: Date | string | null;
  readonly reporter_user_id: string;
  readonly reason_code: string;
  readonly details: string | null;
  readonly report_state: MessagingReportState;
  readonly case_id: string | null;
  readonly case_state: string | null;
  readonly case_severity: string | null;
  readonly report_created_at: Date | string;
}

interface ReportDecisionRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly case_id: string | null;
  readonly state: MessagingReportState;
}

interface StoredActionRow extends QueryResultRow {
  readonly id: string;
  readonly action_type: string;
  readonly reason_code: string;
}

interface MessageSnapshotRow extends QueryResultRow {
  readonly sender_user_id: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function report(row: ReportRow | undefined): MessagingReportRecord {
  if (!row) throw new Error('MESSAGING_REPORT_READ_LOST');
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    reporterUserId: row.reporter_user_id,
    reasonCode: row.reason_code,
    details: row.details,
    state: row.state,
    caseId: row.case_id,
    createdAt: iso(row.created_at),
  };
}

function queueItem(row: ReportQueueRow): MessagingReportQueueItem {
  return {
    reportId: row.report_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageSenderUserId: row.message_sender_user_id,
    messageBody: row.message_body,
    messageCreatedAt: iso(row.message_created_at),
    messageHiddenAt: row.message_hidden_at === null ? null : iso(row.message_hidden_at),
    reporterUserId: row.reporter_user_id,
    reasonCode: row.reason_code,
    details: row.details,
    reportState: row.report_state,
    caseId: row.case_id,
    caseState: row.case_state,
    caseSeverity: row.case_severity,
    createdAt: iso(row.report_created_at),
  };
}

async function lockCommand(
  client: PoolClient,
  namespace: string,
  parts: readonly string[],
): Promise<void> {
  for (const key of parts) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${namespace}:${key}`,
    ]);
  }
}

async function recordModerationAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string | null;
    readonly correlationId: string;
    readonly action: string;
    readonly messageId: string;
    readonly value: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'MESSAGING_MESSAGE', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.messageId,
      input.correlationId,
      JSON.stringify(input.value),
    ],
  );
}

export function createMessagingModerationRepository(pool: Pool): MessagingModerationRepository {
  return {
    submitReport(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, 'messaging-moderation-report', [
          `${input.tenantId}:${input.reporterUserId}:${input.idempotencyKey}`,
          `${input.tenantId}:${input.conversationId}:${input.messageId}`,
        ]);

        // One statement answers three questions at once, so a non-member and an unknown message are
        // indistinguishable: the caller learns only "not found", never whether the message exists.
        const snapshot = await queryOne<MessageSnapshotRow>(
          client,
          `select member.user_id as sender_user_id
             from messaging.messages message
             join messaging.conversation_members member
               on member.tenant_id = message.tenant_id
              and member.conversation_id = message.conversation_id
              and member.id = message.sender_member_id
            where message.tenant_id = $1
              and message.conversation_id = $2
              and message.id = $3
              and message.deleted_at is null
              and exists (
                select 1
                  from messaging.conversation_members reporter
                 where reporter.tenant_id = $1
                   and reporter.conversation_id = $2
                   and reporter.user_id = $4
                   and reporter.member_type = 'USER'
                   and reporter.state = 'ACTIVE'
              )`,
          [input.tenantId, input.conversationId, input.messageId, input.reporterUserId],
        );
        if (!snapshot) return { outcome: 'not_found' } as const;
        if (snapshot.sender_user_id === input.reporterUserId) {
          return { outcome: 'self_report' } as const;
        }

        const existing = await queryOne<ReportRow>(
          client,
          `select ${REPORT_COLUMNS} from moderation.reports
            where tenant_id = $1 and message_id = $2 and reporter_user_id = $3 and reason_code = $4
            for update`,
          [input.tenantId, input.messageId, input.reporterUserId, input.reasonCode],
        );
        if (existing) {
          // A report is identified by what it asserts, not by the command key: the unique
          // `(tenant_id, message_id, reporter_user_id, reason_code)` index plus the advisory lock on
          // the command key make the report row itself the durable idempotency state. An exact retry
          // replays `submitted`; any other repeat of the same assertion answers `duplicate`; a new
          // reason is a new report that joins the same case. No path writes a second report, case or
          // audit row for one assertion, so a reused command key can never fork moderation state.
          if (!existing.case_id) return { outcome: 'duplicate' } as const;
          if (!sameReportRequest(input, existing)) return { outcome: 'duplicate' } as const;
          return {
            outcome: 'submitted',
            report: report(existing),
            caseId: existing.case_id,
            replayed: true,
          } as const;
        }

        const caseId = await resolveReportCase(client, input);
        const reportId = randomUUID();
        const inserted = await queryOne<ReportRow>(
          client,
          `insert into moderation.reports (
             tenant_id, id, conversation_id, message_id, reporter_user_id, reason_code,
             details, state, case_id
           ) values ($1, $2, $3, $4, $5, $6, $7, 'TRIAGED', $8)
           returning ${REPORT_COLUMNS}`,
          [
            input.tenantId,
            reportId,
            input.conversationId,
            input.messageId,
            input.reporterUserId,
            input.reasonCode,
            input.details,
            caseId,
          ],
        );
        if (!inserted) throw new Error('MESSAGING_REPORT_WRITE_LOST');

        await recordModerationAudit(client, {
          tenantId: input.tenantId,
          actorUserId: input.reporterUserId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MESSAGE_REPORTED',
          messageId: input.messageId,
          // Identifiers only: the message body and the free-text report details stay out of audit.
          value: {
            conversationId: input.conversationId,
            messageId: input.messageId,
            reportId,
            caseId,
            reasonCode: input.reasonCode,
          },
        });
        return { outcome: 'submitted', report: report(inserted), caseId, replayed: false } as const;
      });
    },

    listReportQueue(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const cursor = input.afterId
          ? await queryOne<{ readonly created_at: Date | string } & QueryResultRow>(
              client,
              `select created_at from moderation.reports where tenant_id = $1 and id = $2`,
              [input.tenantId, input.afterId],
            )
          : undefined;
        if (input.afterId && !cursor) return [] as const;
        const rows = await client.query<ReportQueueRow>(
          `select report.id as report_id,
                  report.conversation_id,
                  report.message_id,
                  sender.user_id as message_sender_user_id,
                  message.body as message_body,
                  message.created_at as message_created_at,
                  message.hidden_at as message_hidden_at,
                  report.reporter_user_id,
                  report.reason_code,
                  report.details,
                  report.state as report_state,
                  report.case_id,
                  moderation_case.state as case_state,
                  moderation_case.severity as case_severity,
                  report.created_at as report_created_at
             from moderation.reports report
             join moderation.cases moderation_case
               on moderation_case.tenant_id = report.tenant_id
              and moderation_case.id = report.case_id
             join messaging.messages message
               on message.tenant_id = report.tenant_id
              and message.conversation_id = report.conversation_id
              and message.id = report.message_id
             left join messaging.conversation_members sender
               on sender.tenant_id = message.tenant_id
              and sender.conversation_id = message.conversation_id
              and sender.id = message.sender_member_id
            where report.tenant_id = $1
              and report.state in ('SUBMITTED', 'TRIAGED')
              and ($3::timestamptz is null or (report.created_at, report.id) > ($3::timestamptz, $4::uuid))
            order by report.created_at, report.id
            limit $2`,
          [input.tenantId, input.limit, cursor?.created_at ?? null, input.afterId ?? null],
        );
        // CUP moderators decide on real reports, so the body is returned and never redacted here.
        return rows.rows.map(queueItem);
      });
    },

    decideReport(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, 'messaging-moderation-decision', [
          `${input.tenantId}:${input.moderatorUserId}:${input.idempotencyKey}`,
          `${input.tenantId}:${input.reportId}`,
        ]);

        const previous = await queryOne<StoredActionRow>(
          client,
          `select id, action_type, reason_code
             from moderation.actions
            where tenant_id = $1 and idempotency_key = $2
            for update`,
          [input.tenantId, input.idempotencyKey],
        );
        if (previous) {
          const replay = await replayDecision(client, input, previous);
          if (replay) return replay;
        }

        const current = await queryOne<ReportDecisionRow>(
          client,
          `select id, conversation_id, message_id, case_id, state
             from moderation.reports
            where tenant_id = $1 and id = $2
            for update`,
          [input.tenantId, input.reportId],
        );
        if (!current || !current.case_id) return { outcome: 'not_found' } as const;

        const actionId = randomUUID();
        const actionType = actionTypeFor(input.action);
        await insertModerationAction(client, {
          tenantId: input.tenantId,
          actionId,
          caseId: current.case_id,
          actionType,
          reasonCode: input.reasonCode,
          idempotencyKey: input.idempotencyKey,
          actorUserId: input.moderatorUserId,
          correlationId: input.correlationId,
        });
        const hidden = await applyDecision(client, input, current, actionId);
        await recordModerationAudit(client, {
          tenantId: input.tenantId,
          actorUserId: input.moderatorUserId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MESSAGE_MODERATION_DECIDED',
          messageId: current.message_id,
          value: {
            conversationId: current.conversation_id,
            messageId: current.message_id,
            reportId: current.id,
            caseId: current.case_id,
            actionId,
            actionType,
            decision: input.action,
            reasonCode: input.reasonCode,
            hidden,
          },
        });
        return { outcome: 'decided', action: input.action, hidden, replayed: false } as const;
      });
    },
  };
}

/**
 * The stored report is the durable idempotency state, so a retry replays `submitted` exactly when
 * the replayed command describes the same assertion. `details` is part of the comparison because it
 * is the only free-form part of the payload.
 */
function sameReportRequest(
  input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly reporterUserId: string;
    readonly reasonCode: string;
    readonly details: string | null;
  },
  existing: ReportRow,
): boolean {
  return (
    existing.conversation_id === input.conversationId &&
    existing.message_id === input.messageId &&
    existing.reporter_user_id === input.reporterUserId &&
    existing.reason_code === input.reasonCode &&
    existing.details === input.details
  );
}

/**
 * The first report on a message creates the shared case; later reports from other players attach to
 * it through `dedupe_key = 'chat-message:' || messageId`. The dedupe key also decides the case when
 * the insert loses a race, so two concurrent reports never produce two cases for one message.
 */
async function resolveReportCase(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly reasonCode: string;
  },
): Promise<string> {
  const dedupeKey = `chat-message:${input.messageId}`;
  const existing = await queryOne<{ readonly id: string } & QueryResultRow>(
    client,
    `select id from moderation.cases where tenant_id = $1 and dedupe_key = $2`,
    [input.tenantId, dedupeKey],
  );
  if (existing) return existing.id;
  try {
    const created = await queryOne<{ readonly id: string } & QueryResultRow>(
      client,
      `insert into moderation.cases (
         tenant_id, conversation_id, message_id, source, dedupe_key, severity, reason_code, state
       ) values ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
       returning id`,
      [
        input.tenantId,
        input.conversationId,
        input.messageId,
        REPORT_CASE_SOURCE,
        dedupeKey,
        REPORT_CASE_SEVERITY,
        input.reasonCode,
      ],
    );
    if (!created) throw new Error('MESSAGING_REPORT_CASE_WRITE_LOST');
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await queryOne<{ readonly id: string } & QueryResultRow>(
      client,
      `select id from moderation.cases where tenant_id = $1 and dedupe_key = $2`,
      [input.tenantId, dedupeKey],
    );
    if (!raced) throw error;
    return raced.id;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

function actionTypeFor(action: MessagingModerationAction): string {
  return action === 'HIDE_MESSAGE' ? 'REDACT_MESSAGE' : action;
}

async function insertModerationAction(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actionId: string;
    readonly caseId: string;
    readonly actionType: string;
    readonly reasonCode: string;
    readonly idempotencyKey: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `insert into moderation.actions (
       tenant_id, id, case_id, action_type, actor_type, actor_user_id, reason_code,
       idempotency_key, correlation_id
     ) values ($1, $2, $3, $4, 'STAFF', $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.actionId,
      input.caseId,
      input.actionType,
      input.actorUserId,
      input.reasonCode,
      input.idempotencyKey,
      input.correlationId,
    ],
  );
}

/**
 * A hidden message keeps its row, attachments and audit trail; only `hidden_at` changes. The action
 * row is inserted first because `messaging.messages.hidden_by_action_id` references it. The case
 * moves to RESOLVED with `resolved_at` for a hide or a dismissal, and back to OPEN without
 * `resolved_at` for a restore.
 */
async function applyDecision(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly reportId: string;
    readonly action: MessagingModerationAction;
  },
  current: ReportDecisionRow,
  actionId: string,
): Promise<boolean> {
  if (input.action === 'HIDE_MESSAGE') {
    await client.query(
      `update messaging.messages
          set hidden_at = now(), hidden_by_action_id = $4
        where tenant_id = $1 and conversation_id = $2 and id = $3`,
      [input.tenantId, current.conversation_id, current.message_id, actionId],
    );
  }
  if (input.action === 'RESTORE_MESSAGE') {
    await client.query(
      `update messaging.messages
          set hidden_at = null, hidden_by_action_id = null
        where tenant_id = $1 and conversation_id = $2 and id = $3`,
      [input.tenantId, current.conversation_id, current.message_id],
    );
  }
  const resolved = input.action !== 'RESTORE_MESSAGE';
  await client.query(
    `update moderation.cases
        set state = $3,
            resolved_at = ${resolved ? 'now()' : 'null'},
            updated_at = now()
      where tenant_id = $1 and id = $2`,
    [input.tenantId, current.case_id, resolved ? 'RESOLVED' : 'OPEN'],
  );
  if (input.action === 'DISMISS') {
    // Dismissal resolves the case without touching `hidden_at`, and closes every report on the case.
    await client.query(
      `update moderation.reports
          set state = 'DISMISSED', updated_at = now()
        where tenant_id = $1 and case_id = $2 and state in ('SUBMITTED', 'TRIAGED')`,
      [input.tenantId, current.case_id],
    );
    await client.query(
      `update moderation.reports
          set state = 'DISMISSED', updated_at = now()
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.reportId],
    );
  }
  if (input.action === 'HIDE_MESSAGE') return true;
  return currentHidden(client, input.tenantId, current);
}

async function currentHidden(
  client: PoolClient,
  tenantId: string,
  current: ReportDecisionRow,
): Promise<boolean> {
  const row = await queryOne<{ readonly hidden_at: Date | string | null } & QueryResultRow>(
    client,
    `select hidden_at from messaging.messages
      where tenant_id = $1 and conversation_id = $2 and id = $3`,
    [tenantId, current.conversation_id, current.message_id],
  );
  return row?.hidden_at != null;
}

/** A replay returns the stored decision; the same key with a different payload is a conflict. */
async function replayDecision(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly action: MessagingModerationAction;
    readonly reasonCode: string;
  },
  previous: StoredActionRow,
): Promise<MessagingReportDecisionResult | undefined> {
  if (
    previous.action_type !== actionTypeFor(input.action) ||
    previous.reason_code !== input.reasonCode
  ) {
    return { outcome: 'idempotency_conflict' } as const;
  }
  const message = await queryOne<{ readonly hidden_at: Date | string | null } & QueryResultRow>(
    client,
    `select message.hidden_at
       from messaging.messages message
      where message.tenant_id = $1 and message.hidden_by_action_id = $2`,
    [input.tenantId, previous.id],
  );
  return {
    outcome: 'decided',
    action: previous.action_type === 'REDACT_MESSAGE' ? 'HIDE_MESSAGE' : input.action,
    hidden: message?.hidden_at != null,
    replayed: true,
  } as const;
}
