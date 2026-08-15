import {
  bookingNotificationContractHash,
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT,
  BOOKING_NOTIFICATION_REQUEST_HASH,
} from '@phub/notifications';
import { describe, expect, it, vi } from 'vitest';

import { assertCanonicalBookingReminderReady } from './booking-notification-contract.js';

const canonicalRule = {
  rule_key: 'booking.reminder.default',
  audience_selector: { type: 'EVENT_USERS', field: 'recipientUserIds' },
  channel_override: ['IN_APP', 'PUSH'],
  mandatory: false,
  template_key: 'booking.reminder',
  template_version: 2,
  template_locale: 'ru-RU',
  template_category: 'BOOKING',
  template_channels: ['IN_APP', 'PUSH'],
  title_template: 'Напоминание о записи',
  body_template: '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
  deep_link_template: '/bookings',
  template_active: true,
  effective_channels: ['IN_APP', 'PUSH'],
};

function clientFor(rows: readonly Record<string, unknown>[], provisioned = true) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rowCount: provisioned ? 1 : 0,
      rows: provisioned ? [{ idempotency_key: 'booking-contract-test' }] : [],
    })
    .mockResolvedValueOnce({ rowCount: rows.length, rows });
  return { client: { query } as never, query };
}

describe('booking notification canonical activation contract', () => {
  it('hashes every canonical ruleset field', () => {
    expect(BOOKING_NOTIFICATION_REQUEST_HASH).toMatch(/^[0-9a-f]{64}$/);
    const contract = BOOKING_NOTIFICATION_CANONICAL_CONTRACT;
    const variants: readonly object[] = [
      { ...contract, rulesetVersion: 'booking.ru-ru.v4' },
      { ...contract, template: { ...contract.template, version: 3 } },
      { ...contract, template: { ...contract.template, locale: 'en-US' } },
      { ...contract, template: { ...contract.template, category: 'GAME' } },
      { ...contract, template: { ...contract.template, deepLink: '/old' } },
      { ...contract, template: { ...contract.template, channels: ['IN_APP'] } },
      { ...contract, template: { ...contract.template, active: false } },
      { ...contract, rule: { ...contract.rule, keySuffix: 'legacy' } },
      {
        ...contract,
        rule: {
          ...contract.rule,
          audienceSelector: { ...contract.rule.audienceSelector, type: 'TENANT_USERS' },
        },
      },
      {
        ...contract,
        rule: {
          ...contract.rule,
          audienceSelector: { ...contract.rule.audienceSelector, field: 'users' },
        },
      },
      { ...contract, rule: { ...contract.rule, channelOverride: ['PUSH'] } },
      { ...contract, rule: { ...contract.rule, active: false } },
      {
        ...contract,
        definitions: contract.definitions.map((definition, index) =>
          index === 3 ? { ...definition, key: 'booking.reminder.changed' } : definition,
        ),
      },
      {
        ...contract,
        definitions: contract.definitions.map((definition, index) =>
          index === 3 ? { ...definition, sourceEventType: 'booking.reminder.due.v2' } : definition,
        ),
      },
      {
        ...contract,
        definitions: contract.definitions.map((definition, index) =>
          index === 3 ? { ...definition, title: 'Changed reminder title' } : definition,
        ),
      },
      {
        ...contract,
        definitions: contract.definitions.map((definition, index) =>
          index === 3 ? { ...definition, body: 'Changed reminder body' } : definition,
        ),
      },
      {
        ...contract,
        definitions: contract.definitions.map((definition, index) =>
          index === 3 ? { ...definition, mandatory: true } : definition,
        ),
      },
    ];
    for (const variant of variants) {
      expect(bookingNotificationContractHash(variant)).not.toBe(BOOKING_NOTIFICATION_REQUEST_HASH);
    }
  });

  it('accepts exactly one provisioned canonical reminder rule with an enabled channel', async () => {
    const { client, query } = clientFor([canonicalRule]);

    await expect(
      assertCanonicalBookingReminderReady(
        client,
        'tenant-id',
        { inAppEnabled: true, webPushEnabled: false },
        true,
      ),
    ).resolves.toBeUndefined();

    expect(String(query.mock.calls[0]?.[0])).toContain('ruleset_provision_commands');
    expect(query.mock.calls[0]?.[1]).toEqual([
      'tenant-id',
      'booking.ru-ru.v3',
      BOOKING_NOTIFICATION_REQUEST_HASH,
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain('for share of trigger_rule, template');
  });

  it('rejects an unprovisioned rule even if its row shape would otherwise be canonical', async () => {
    const { client, query } = clientFor([canonicalRule], false);

    await expect(
      assertCanonicalBookingReminderReady(
        client,
        'tenant-id',
        { inAppEnabled: true, webPushEnabled: false },
        false,
      ),
    ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an extra active reminder rule', async () => {
    const { client } = clientFor([
      canonicalRule,
      { ...canonicalRule, rule_key: 'booking.reminder.custom' },
    ]);

    await expect(
      assertCanonicalBookingReminderReady(
        client,
        'tenant-id',
        { inAppEnabled: true, webPushEnabled: true },
        false,
      ),
    ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
  });

  it.each([
    ['template version', { template_version: 1 }],
    ['locale', { template_locale: 'en-US' }],
    ['category', { template_category: 'GAME' }],
    ['title', { title_template: 'Old title' }],
    ['body', { body_template: 'Old body' }],
    ['deep link', { deep_link_template: '/old' }],
    ['audience selector', { audience_selector: { type: 'TENANT_USERS' } }],
    ['mandatory flag', { mandatory: true }],
    ['inactive template', { template_active: false }],
    ['rule channels', { channel_override: ['PUSH', 'IN_APP'] }],
    ['template channels', { template_channels: ['PUSH', 'IN_APP'] }],
  ] as const)('rejects canonical drift in %s', async (_description, change) => {
    const { client } = clientFor([{ ...canonicalRule, ...change }]);

    await expect(
      assertCanonicalBookingReminderReady(
        client,
        'tenant-id',
        { inAppEnabled: true, webPushEnabled: true },
        false,
      ),
    ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
  });

  it('rejects a PUSH-only effective rule when only IN_APP is enabled', async () => {
    const { client } = clientFor([
      {
        ...canonicalRule,
        channel_override: ['PUSH'],
        effective_channels: ['PUSH'],
      },
    ]);

    await expect(
      assertCanonicalBookingReminderReady(
        client,
        'tenant-id',
        { inAppEnabled: true, webPushEnabled: false },
        false,
      ),
    ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_CHANNEL_NOT_READY');
  });
});
