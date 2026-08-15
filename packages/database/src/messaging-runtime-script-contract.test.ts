import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { assertCommsOperatorAccess } from '../../../scripts/messaging-runtime-access.js';

describe('messaging runtime operator command', () => {
  it('requires current comms-operator authority for preview and apply', async () => {
    const source = await readFile(
      new URL('../../../scripts/set-messaging-runtime.ts', import.meta.url),
      'utf8',
    );

    expect(source.match(/assertCommsOperatorAccess\(client, tenantId, actorId\)/g)).toHaveLength(2);
    expect(source).toContain('MESSAGING_RUNTIME_CHANGED');
    expect(source.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      source.lastIndexOf('assertCommsOperatorAccess(client, tenantId, actorId)'),
    );
  });

  it('fails closed when the actor lacks the current admin permission pair', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      assertCommsOperatorAccess({ query } as never, 'tenant-id', 'actor-id'),
    ).rejects.toThrow('ADMIN_PERMISSION_REQUIRED');
    expect(String(query.mock.calls[0]?.[0])).toContain("'admin' = any(access.roles)");
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "'notifications.manage' = any(access.permissions)",
    );
  });

  it('accepts exactly one active authorized access row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });

    await expect(
      assertCommsOperatorAccess({ query } as never, 'tenant-id', 'actor-id'),
    ).resolves.toBeUndefined();
  });
});

describe('notification runtime operator command', () => {
  it('keeps booking reminders explicit, audited and protected from stale operator authority', async () => {
    const [source, contract, canonicalContract, provisioner] = await Promise.all([
      readFile(new URL('../../../scripts/set-notification-runtime.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../scripts/booking-notification-contract.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../notifications/src/index.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../scripts/provision-booking-notifications.ts', import.meta.url),
        'utf8',
      ),
    ]);

    expect(source.match(/assertCommsOperatorAccess\(client, tenantId, actorId\)/g)).toHaveLength(3);
    expect(source.match(/assertCanonicalBookingReminderReady\(/g)).toHaveLength(2);
    expect(source).toContain("argument('booking-reminders') ?? 'keep'");
    expect(source).toContain('booking_reminders_enabled');
    expect(source).toContain('booking_reminder_ruleset_version');
    expect(source).toContain('booking_reminder_contract_hash');
    expect(source).toContain('BOOKING_NOTIFICATION_RULESET_VERSION');
    expect(source).toContain('BOOKING_NOTIFICATION_REQUEST_HASH');
    expect(source).toContain('NOTIFICATION_RUNTIME_CHANGED_CONCURRENTLY');
    expect(source).toContain('BOOKING_REMINDER_TRANSPORT_NOT_ENABLED');
    expect(contract).toContain('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
    expect(contract).toContain('BOOKING_REMINDER_NOTIFICATION_CHANNEL_NOT_READY');
    expect(canonicalContract).toContain("sourceEventType: 'booking.reminder.due.v1'");
    expect(contract).toContain('for share of trigger_rule, template');
    expect(contract).toContain('BOOKING_NOTIFICATION_REQUEST_HASH');
    expect(provisioner).toContain('`notification-runtime:${tenantId}`');
    expect(source).toContain('bookingRemindersEnabled: desiredBookingRemindersEnabled');
    expect(source).toContain('bookingReminderRulesetVersion: desiredBookingReminderRulesetVersion');
    expect(source).toContain('bookingReminderContractHash: desiredBookingReminderContractHash');
    expect(source.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      source.lastIndexOf('assertCommsOperatorAccess(client, tenantId, actorId)'),
    );
  });
});
