import type { NotificationSourceEvent } from '@phub/notifications';
import { describe, expect, it, vi } from 'vitest';

import { applyNotificationSourceEvent } from './notification-projector.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const event: NotificationSourceEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'game.starting-soon.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId,
  occurredAt: '2026-07-16T12:00:00.000Z',
  correlationId: 'notification-worker-test-123',
  payload: { recipientUserId: userId, startsAt: '19:00' },
};

describe('notification intent projector', () => {
  it('consumes but does not project while the tenant gate is disabled', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into audit.inbox_events')) {
        return Promise.resolve({ rows: [{ event_id: event.id }], rowCount: 1 });
      }
      if (text.includes('from notifications.tenant_runtime_settings')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('update audit.inbox_events')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(applyNotificationSourceEvent({ pool: pool as never, event })).resolves.toEqual({
      outcome: 'disabled',
    });
    expect(query.mock.calls.some(([text]) => String(text).includes('notifications.intents'))).toBe(
      false,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('creates intent, in-app delivery, inbox, audit and identifier-only outbox atomically', async () => {
    const intentId = '33333333-3333-4333-8333-333333333333';
    const deliveryId = '44444444-4444-4444-8444-444444444444';
    const inboxItemId = '55555555-5555-4555-8555-555555555555';
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into audit.inbox_events')) {
        return Promise.resolve({ rows: [{ event_id: event.id }], rowCount: 1 });
      }
      if (text.includes('from notifications.tenant_runtime_settings')) {
        return Promise.resolve({ rows: [{ in_app_enabled: true }], rowCount: 1 });
      }
      if (text.includes('from notifications.trigger_rules')) {
        return Promise.resolve({
          rows: [
            {
              rule_id: '66666666-6666-4666-8666-666666666666',
              template_id: '77777777-7777-4777-8777-777777777777',
              audience_selector: { type: 'EVENT_USER', field: 'recipientUserId' },
              mandatory: false,
              effective_channels: ['IN_APP'],
              category: 'GAME',
              title_template: 'Игра скоро начнётся',
              body_template: 'Начало в {{startsAt}}',
              deep_link_template: '/games/{{aggregateId}}',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from identity.users')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      if (text.includes('from notifications.user_preferences')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into notifications.intents')) {
        return Promise.resolve({ rows: [{ id: intentId }], rowCount: 1 });
      }
      if (text.includes('insert into notifications.deliveries')) {
        return Promise.resolve({ rows: [{ id: deliveryId }], rowCount: 1 });
      }
      if (text.includes('insert into notifications.inbox_items')) {
        return Promise.resolve({ rows: [{ id: inboxItemId }], rowCount: 1 });
      }
      if (
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('update audit.inbox_events')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(applyNotificationSourceEvent({ pool: pool as never, event })).resolves.toEqual({
      outcome: 'processed',
      created: 1,
      suppressed: 0,
      pushQueued: 0,
      skippedRules: 0,
    });
    expect(
      query.mock.calls.filter(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toHaveLength(2);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
