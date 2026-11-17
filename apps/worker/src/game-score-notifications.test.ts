import { describe, expect, it, vi } from 'vitest';
import { GAME_NOTIFICATION_DEFINITIONS, notificationSourceEventSchema } from '@phub/notifications';
import { applyNotificationSourceEvent } from './notification-projector.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const gameId = '55555555-5555-4555-8555-555555555555';
const base = {
  id: '66666666-6666-4666-8666-666666666666',
  aggregateId: gameId,
  tenantId: '77777777-7777-4777-8777-777777777777',
  occurredAt: '2026-11-15T17:00:00Z',
  correlationId: 'synthetic-score-notification',
};
function harness(
  type: 'game.finished.v1' | 'game.result.submitted.v1',
  changes: {
    now?: string;
    state?: string;
    duplicate?: boolean;
    optedOut?: boolean;
    currentSubmission?: boolean;
  } = {},
) {
  const payload = {
    gameId,
    aggregateRevision: '4',
    causationId: '88888888-8888-4888-8888-888888888888',
    actorUserId: ids[0],
  };
  const event = notificationSourceEventSchema.parse({
    ...base,
    type,
    payload:
      type === 'game.finished.v1'
        ? { ...payload, participantUserIds: ids }
        : {
            ...payload,
            submissionId: '99999999-9999-4999-8999-999999999999',
            submittedByUserId: ids[0],
            requiredConfirmationUserIds: ids.slice(1),
          },
  });
  const definition = GAME_NOTIFICATION_DEFINITIONS.find((d) => d.sourceEventType === type)!;
  const stored: { values: readonly unknown[] }[] = [];
  const deliveries: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    await Promise.resolve();
    if (sql.includes('insert into audit.inbox_events'))
      return { rows: [], rowCount: changes.duplicate ? 0 : 1 };
    if (sql.includes('from games.games g'))
      return {
        rows: [
          {
            ends_at: '2026-11-15T16:00:00Z',
            database_now: changes.now ?? '2026-11-15T17:00:00Z',
            result_state:
              changes.state ??
              (type === 'game.finished.v1' ? 'AWAITING_SUBMISSION' : 'PENDING_CONFIRMATION'),
            lifecycle_state: 'FINISHED',
            current_submission: changes.currentSubmission ?? true,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('tenant_runtime_settings'))
      return {
        rows: [
          {
            in_app_enabled: true,
            web_push_enabled: false,
            android_push_enabled: true,
            ios_push_enabled: false,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('from notifications.trigger_rules'))
      return {
        rows: [
          {
            rule_id: base.id,
            template_id: base.id,
            audience_selector: definition.audienceSelector,
            mandatory: definition.mandatory,
            effective_channels: definition.channels,
            category: definition.category,
            title_template: definition.title,
            body_template: definition.body,
            deep_link_template: '/games/{{gameId}}',
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('from identity.users')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('from notifications.user_preferences'))
      return {
        rows: changes.optedOut ? [{ channel: 'PUSH', enabled: false }] : [],
        rowCount: changes.optedOut ? 1 : 0,
      };
    if (sql.includes('from integration.notification_endpoints'))
      return { rows: [{ id: base.id }], rowCount: 1 };
    if (sql.includes('insert into notifications.intents')) {
      stored.push({ values });
      return { rows: [{ id: base.id }], rowCount: 1 };
    }
    if (sql.includes('insert into notifications.deliveries')) {
      if (sql.includes("'PUSH'")) deliveries.push(values);
      return { rows: [{ id: base.id }], rowCount: 1 };
    }
    if (sql.includes('insert into notifications.inbox_items'))
      return { rows: [{ id: base.id }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const pool = { connect: () => Promise.resolve({ query, release: vi.fn() }) };
  return {
    stored,
    deliveries,
    query,
    run: () =>
      applyNotificationSourceEvent({
        pool: pool as never,
        event,
        androidPush: { appId: 'ru.padlhub.app', environment: 'SANDBOX' },
      }),
  };
}
describe('score notifications from authoritative game facts', () => {
  it.each(['game.finished.v1', 'game.result.submitted.v1'] as const)(
    'queues %s to all four players including the submitter with the original deadline',
    async (type) => {
      const h = harness(type);
      expect(await h.run()).toMatchObject({ outcome: 'processed', created: 4, pushQueued: 4 });
      expect(h.stored.map((item) => item.values[1])).toEqual(ids);
      expect(h.deliveries).toHaveLength(4);
      for (const item of h.stored) {
        expect(item.values[8]).toContain('07:00');
        expect(item.values[8]).toContain('МСК');
        expect(item.values[9]).toBe(`/games/${gameId}`);
        expect(
          (JSON.parse(String(item.values[6])) as Record<string, unknown>).resultDeadlineAt,
        ).toBe('2026-11-16T04:00:00.000Z');
      }
    },
  );
  it('deduplicates broker redelivery before creating any new push', async () => {
    const h = harness('game.finished.v1', { duplicate: true });
    expect(await h.run()).toEqual({ outcome: 'duplicate' });
    expect(h.stored).toHaveLength(0);
  });
  it.each(['game.finished.v1', 'game.result.submitted.v1'] as const)(
    'suppresses %s at the exact deadline',
    async (type) => {
      const h = harness(type, { now: '2026-11-16T04:00:00Z' });
      expect(await h.run()).toEqual({ outcome: 'suppressed' });
      expect(h.deliveries).toHaveLength(0);
    },
  );
  it('suppresses a stale score-entry prompt after a submission', async () => {
    expect(await harness('game.finished.v1', { state: 'PENDING_CONFIRMATION' }).run()).toEqual({
      outcome: 'suppressed',
    });
  });
  it('suppresses an obsolete submission superseded after a dispute', async () => {
    expect(await harness('game.result.submitted.v1', { currentSubmission: false }).run()).toEqual({
      outcome: 'suppressed',
    });
  });
  it('honors category push opt-out while retaining the in-app notice', async () => {
    const h = harness('game.result.submitted.v1', { optedOut: true });
    expect(await h.run()).toMatchObject({ outcome: 'processed', created: 4, pushQueued: 0 });
    expect(h.deliveries).toHaveLength(0);
  });
});
