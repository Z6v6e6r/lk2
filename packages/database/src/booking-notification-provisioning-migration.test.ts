import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('booking notification provisioning migration', () => {
  it('adds only an idempotency journal with forced tenant RLS', async () => {
    const sql = await readFile(
      new URL('../migrations/0054_booking_notification_provisioning.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('create table if not exists notifications.ruleset_provision_commands');
    expect(sql).toContain('primary key (tenant_id, idempotency_key)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).not.toContain('insert into notifications.templates');
    expect(sql).not.toContain('insert into notifications.trigger_rules');
    expect(sql).not.toContain('tenant_runtime_settings');
  });
});
