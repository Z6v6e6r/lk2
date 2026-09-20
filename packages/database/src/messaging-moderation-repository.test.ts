import { describe, expect, it, vi } from 'vitest';

import { createMessagingModerationRepository } from './messaging-moderation-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const reporterUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const senderUserId = '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const moderatorUserId = '69d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '33333333-3333-4333-8333-333333333333';
const reportId = '44444444-4444-4444-8444-444444444444';
const caseId = '55555555-5555-4555-8555-555555555555';
const actionId = '66666666-6666-4666-8666-666666666666';
const idempotencyKey = 'messaging-report-command-0001';
const correlationId = 'messaging-report-correlation-0001';

const reportRow = {
  id: reportId,
  conversation_id: conversationId,
  message_id: messageId,
  reporter_user_id: reporterUserId,
  reason_code: 'SPAM',
  details: null,
  state: 'TRIAGED' as const,
  case_id: caseId,
  created_at: '2026-09-20T12:00:00.000Z',
};

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

const auditInsert = 'insert into audit.audit_log';

/**
 * Shared plumbing: transaction keywords, advisory locks and the audit row are always allowed. The
 * audit insert echoes `reportRow` so a test can assert the exact `new_value` payload it captured.
 */
function scaffolding(text: string): { rows: readonly unknown[]; rowCount: number } | undefined {
  if (
    text === 'begin' ||
    text === 'commit' ||
    text === 'rollback' ||
    text.includes("set_config('app.tenant_id'") ||
    text.includes('pg_advisory_xact_lock')
  ) {
    return { rows: [], rowCount: 0 };
  }
  if (text.includes(auditInsert)) return { rows: [reportRow], rowCount: 1 };
  return undefined;
}

describe('messaging moderation repository', () => {
  it('treats a non-member as not_found and writes nothing', async () => {
    const query = vi.fn((text: string) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Non-member must not read or write anything else: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'SPAM',
        details: null,
        idempotencyKey,
        requestHash: 'hash-0001',
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });

    expect(
      query.mock.calls.some(([text]) =>
        /insert into moderation\.(?:reports|cases)|update moderation\.reports|insert into audit\.audit_log/.test(
          String(text),
        ),
      ),
    ).toBe(false);
  });

  it('answers self_report without writing a report, a case or an audit row', async () => {
    const query = vi.fn((text: string) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: reporterUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      throw new Error(`Self-report must not write anything: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'ABUSE',
        details: 'неприемлемый текст',
        idempotencyKey,
        requestHash: 'hash-0002',
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'self_report' });

    expect(
      query.mock.calls.some(([text]) =>
        /insert into moderation\.(?:reports|cases)|insert into audit\.audit_log/.test(String(text)),
      ),
    ).toBe(false);
  });

  it('creates the shared case with the chat-message dedupe key and links the first report', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: senderUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into moderation.cases')) {
        expect(text).toContain("'OPEN'");
        expect(values).toContain(`chat-message:${messageId}`);
        expect(values).toContain('USER_REPORT');
        expect(values).toContain('MEDIUM');
        return Promise.resolve({ rows: [{ id: caseId }], rowCount: 1 });
      }
      if (text.includes('from moderation.cases')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into moderation.reports')) {
        expect(text).toContain("'TRIAGED'");
        expect(values).toContain(caseId);
        return Promise.resolve({ rows: [reportRow], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'SPAM',
        details: null,
        idempotencyKey,
        requestHash: 'hash-0001',
        correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'submitted',
      report: {
        id: reportId,
        conversationId,
        messageId,
        reporterUserId,
        reasonCode: 'SPAM',
        details: null,
        state: 'TRIAGED',
        caseId,
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      caseId,
      replayed: false,
    });

    const audit = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(audit).toBeDefined();
    const auditPayload = String(audit?.[1]?.[5]);
    expect(auditPayload).toContain(messageId);
    expect(auditPayload).not.toContain('неприемлемый');
  });

  it('joins a second reason from the same reporter to the existing case', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: senderUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from moderation.cases')) {
        return Promise.resolve({ rows: [{ id: caseId }], rowCount: 1 });
      }
      if (text.includes('insert into moderation.reports')) {
        expect(values).toContain(caseId);
        expect(values).toContain('ABUSE');
        return Promise.resolve({
          rows: [{ ...reportRow, reason_code: 'ABUSE' }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    const result = await repository.submitReport({
      tenantId,
      reporterUserId,
      conversationId,
      messageId,
      reasonCode: 'ABUSE',
      details: null,
      idempotencyKey: 'messaging-report-command-0002',
      requestHash: 'hash-0003',
      correlationId,
    });

    expect(result).toMatchObject({ outcome: 'submitted', caseId, replayed: false });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into moderation.cases')),
    ).toBe(false);
  });

  it('replays a byte-identical retry without inserting a second case or report', async () => {
    const query = vi.fn((text: string) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: senderUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      // The stored report row is the whole durable idempotency state: no command table, no update.
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({ rows: [reportRow], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'SPAM',
        details: null,
        idempotencyKey,
        requestHash: 'hash-0001',
        correlationId,
      }),
    ).resolves.toMatchObject({ outcome: 'submitted', caseId, replayed: true });

    expect(
      query.mock.calls.some(([text]) =>
        /insert into moderation\.(?:reports|cases)|insert into audit\.audit_log/.test(String(text)),
      ),
    ).toBe(false);
  });

  it('answers duplicate when the same report key carries a different details payload', async () => {
    const query = vi.fn((text: string) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: senderUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({ rows: [reportRow], rowCount: 1 });
      }
      throw new Error(`A repeated report key must never write: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    // Without a moderation command table the stored report is the only idempotency state, so a
    // reused command key with a different payload is a duplicate, not a second case or action.
    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'SPAM',
        details: 'другой текст',
        idempotencyKey,
        requestHash: 'hash-9999',
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'duplicate' });
  });

  it('answers duplicate for a different reason from the same reporter and message', async () => {
    const query = vi.fn((text: string) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ sender_user_id: senderUserId, hidden_at: null }],
          rowCount: 1,
        });
      }
      if (text.includes('from moderation.reports')) {
        // A different reason means a different row, so the case cannot already be attached.
        return Promise.resolve({
          rows: [{ ...reportRow, reason_code: 'SPAM', case_id: null }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.submitReport({
        tenantId,
        reporterUserId,
        conversationId,
        messageId,
        reasonCode: 'SPAM',
        details: null,
        idempotencyKey: 'messaging-report-command-0003',
        requestHash: 'hash-0001',
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'duplicate' });

    expect(
      query.mock.calls.some(([text]) =>
        /insert into moderation\.(?:reports|cases)|insert into audit\.audit_log/.test(String(text)),
      ),
    ).toBe(false);
  });

  it('lists the oldest-first queue with the reporter, case and unredacted body', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from moderation.reports report')) {
        expect(text).toContain("report.state in ('SUBMITTED', 'TRIAGED')");
        expect(text).toContain('order by report.created_at, report.id');
        expect(values).toEqual([tenantId, 50, null, null]);
        return Promise.resolve({
          rows: [
            {
              report_id: reportId,
              conversation_id: conversationId,
              message_id: messageId,
              message_sender_user_id: senderUserId,
              message_body: 'текст сообщения',
              message_created_at: '2026-09-20T11:00:00.000Z',
              message_hidden_at: null,
              reporter_user_id: reporterUserId,
              reason_code: 'SPAM',
              details: 'спам',
              report_state: 'TRIAGED',
              case_id: caseId,
              case_state: 'OPEN',
              case_severity: 'MEDIUM',
              report_created_at: '2026-09-20T12:00:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(repository.listReportQueue({ tenantId, limit: 50 })).resolves.toEqual([
      {
        reportId,
        conversationId,
        messageId,
        messageSenderUserId: senderUserId,
        messageBody: 'текст сообщения',
        messageCreatedAt: '2026-09-20T11:00:00.000Z',
        messageHiddenAt: null,
        reporterUserId,
        reasonCode: 'SPAM',
        details: 'спам',
        reportState: 'TRIAGED',
        caseId,
        caseState: 'OPEN',
        caseSeverity: 'MEDIUM',
        createdAt: '2026-09-20T12:00:00.000Z',
      },
    ]);
  });

  it('hides through a REDACT_MESSAGE action before the message columns and resolves the case', async () => {
    const order: string[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text.includes('from moderation.actions')) {
        order.push('actions');
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from moderation.reports')) {
        order.push('report');
        return Promise.resolve({
          rows: [
            {
              id: reportId,
              conversation_id: conversationId,
              message_id: messageId,
              case_id: caseId,
              state: 'TRIAGED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into moderation.actions')) {
        order.push('insert-action');
        expect(values).toContain('REDACT_MESSAGE');
        expect(text).toContain("'STAFF'");
        expect(values).toContain(moderatorUserId);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update messaging.messages')) {
        order.push('hide-message');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update moderation.cases')) {
        order.push('resolve-case');
        expect(text).toContain('resolved_at = now()');
        expect(values).toContain('RESOLVED');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'HIDE_MESSAGE',
        reasonCode: 'POLICY_VIOLATION',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: false,
    });

    expect(order).toEqual(['actions', 'report', 'insert-action', 'hide-message', 'resolve-case']);
    const audit = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(String(audit?.[1]?.[2])).toBe('MESSAGING_MESSAGE_MODERATION_DECIDED');
    expect(String(audit?.[1]?.[5])).not.toContain('текст');
  });

  it('restores by clearing both hidden columns and reopening the case without resolved_at', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text.includes('from moderation.actions')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({
          rows: [
            {
              id: reportId,
              conversation_id: conversationId,
              message_id: messageId,
              case_id: caseId,
              state: 'TRIAGED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into moderation.actions')) {
        expect(values).toContain('RESTORE_MESSAGE');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update messaging.messages')) {
        expect(text).toContain('hidden_at = null');
        expect(text).toContain('hidden_by_action_id = null');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update moderation.cases')) {
        expect(text).toContain('resolved_at = null');
        expect(values).toContain('OPEN');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select hidden_at from messaging.messages')) {
        return Promise.resolve({ rows: [{ hidden_at: null }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'RESTORE_MESSAGE',
        reasonCode: 'APPEAL_ACCEPTED',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'decided',
      action: 'RESTORE_MESSAGE',
      hidden: false,
      replayed: false,
    });
  });

  it('dismisses the case without touching hidden_at', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text.includes('from moderation.actions')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({
          rows: [
            {
              id: reportId,
              conversation_id: conversationId,
              message_id: messageId,
              case_id: caseId,
              state: 'TRIAGED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into moderation.actions')) {
        expect(values).toContain('DISMISS');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update moderation.cases')) {
        expect(values).toContain('RESOLVED');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update moderation.reports')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select hidden_at from messaging.messages')) {
        return Promise.resolve({ rows: [{ hidden_at: null }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'DISMISS',
        reasonCode: 'NOT_A_VIOLATION',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'decided', action: 'DISMISS', hidden: false, replayed: false });

    expect(
      query.mock.calls.some(([text]) => String(text).includes('update messaging.messages')),
    ).toBe(false);
  });

  it('replays a stored decision and refuses a different payload on the same key', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from moderation.actions')) {
        expect(values).toContain(idempotencyKey);
        return Promise.resolve({
          rows: [{ id: actionId, action_type: 'REDACT_MESSAGE', reason_code: 'POLICY_VIOLATION' }],
          rowCount: 1,
        });
      }
      if (text.includes('from messaging.messages message')) {
        return Promise.resolve({
          rows: [{ hidden_at: '2026-09-20T12:05:00.000Z' }],
          rowCount: 1,
        });
      }
      throw new Error(`Replay must not write or re-resolve the report: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'HIDE_MESSAGE',
        reasonCode: 'POLICY_VIOLATION',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: true,
    });

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'DISMISS',
        reasonCode: 'NOT_A_VIOLATION',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it('answers not_found for an unknown report without writing an action', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('from moderation.actions')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (scaffolding(text)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('from moderation.reports')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unknown report must not write anything: ${text}`);
    });
    const repository = createMessagingModerationRepository(poolWithQuery(query) as never);

    await expect(
      repository.decideReport({
        tenantId,
        moderatorUserId,
        reportId,
        action: 'DISMISS',
        reasonCode: 'NOT_A_VIOLATION',
        idempotencyKey,
        correlationId,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });

    expect(
      query.mock.calls.some(([text]) =>
        /insert into moderation\.actions|update messaging\.messages|insert into audit\.audit_log/.test(
          String(text),
        ),
      ),
    ).toBe(false);
  });
});
