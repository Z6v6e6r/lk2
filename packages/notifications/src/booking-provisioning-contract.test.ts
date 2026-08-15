import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('booking notification provisioning contract', () => {
  it('is explicit, audited, idempotent and does not change tenant runtime gates', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-booking-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain("const CONFIRMATION_TOKEN = 'APPLY_BOOKING_NOTIFICATION_RULESET'");
    expect(contract).toContain("rulesetVersion: 'booking.ru-ru.v3'");
    expect(contract).toContain('version: 2');
    expect(contract).toContain("category: 'BOOKING'");
    expect(contract).toContain("channels: ['IN_APP', 'PUSH']");
    expect(contract).toContain("field: 'recipientUserIds'");
    expect(source).toContain('const RULESET_VERSION = BOOKING_NOTIFICATION_RULESET_VERSION');
    expect(source).toContain('const TEMPLATE_VERSION = BOOKING_NOTIFICATION_TEMPLATE_VERSION');
    expect(source).toContain('templateVersion: TEMPLATE_VERSION');
    expect(source).toContain('values ($1, $2, $3, $4, $5, $6::text[]');
    expect(source).toContain('version = $3 and locale = $4');
    expect(source).toContain('on conflict (tenant_id, template_key, version, locale) do nothing');
    expect(source).toContain('and id <> $4 and active = true');
    expect(source).toContain('template_id = excluded.template_id');
    expect(source.indexOf('set active = false')).toBeLessThan(
      source.indexOf('on conflict (tenant_id, rule_key) do update'),
    );
    expect(source).not.toContain('set title_template =');
    expect(source).not.toContain('set body_template =');
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(source).toContain('BOOKING_NOTIFICATION_RULESET_PROVISIONED');
    expect(source).toContain('JSON.stringify(BOOKING_NOTIFICATION_AUDIENCE_SELECTOR)');
    expect(contract).toContain("deepLink: '/bookings'");
    expect(source).toContain('const TEMPLATE_DEEP_LINK = BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK');
    expect(contract).toContain('bookingNotificationContractHash(');
    expect(source).toContain('deep_link_template === TEMPLATE_DEEP_LINK');
    expect(source).toContain('[...BOOKING_NOTIFICATION_TEMPLATE_CHANNELS]');
    expect(source).toContain('[...BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE]');
    expect(source).toContain('BOOKING_NOTIFICATION_TEMPLATE_ACTIVE');
    expect(source).toContain('BOOKING_NOTIFICATION_RULE_ACTIVE');
    expect(source).toContain('set active = $3');
    expect(source).not.toContain('/bookings/{{bookingId}}');
    expect(source).toContain("'admin' = any(access.roles)");
    expect(source).toContain("'notifications.manage' = any(access.permissions)");
    expect(source).toContain("throw new Error('ADMIN_PERMISSION_REQUIRED')");
    expect(
      source.match(/assertNotificationAdminAccess\(client, tenantId, actorId\)/g),
    ).toHaveLength(2);
    expect(source).toContain('`notification-runtime:${tenantId}`');
    expect(source).toContain('BOOKING_NOTIFICATION_REQUEST_HASH');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
  });
});
