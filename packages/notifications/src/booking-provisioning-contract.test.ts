import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('booking notification provisioning contract', () => {
  it('is explicit, audited, idempotent and does not change tenant runtime gates', async () => {
    const source = await readFile(
      new URL('../../../scripts/provision-booking-notifications.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("const CONFIRMATION_TOKEN = 'APPLY_BOOKING_NOTIFICATION_RULESET'");
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(source).toContain('BOOKING_NOTIFICATION_RULESET_PROVISIONED');
    expect(source).toContain('\'{"type":"EVENT_USERS","field":"recipientUserIds"}\'::jsonb');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
  });
});
