import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('booking reminder scheduler migration', () => {
  it('adds an expand-only tenant gate and durable tenant-scoped schedule', async () => {
    const sql = await readFile(
      new URL('../migrations/0073_booking_reminder_scheduler.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain('phub:reviewed-new-table-index');
    expect(sql).toContain('add column booking_reminders_enabled boolean not null default false');
    expect(sql).toContain('add column booking_reminder_ruleset_version text');
    expect(sql).toContain('add column booking_reminder_contract_hash text');
    expect(sql).toContain('tenant_runtime_booking_reminder_binding_check');
    expect(sql).toContain('booking_reminders_enabled = false');
    expect(sql).toContain('booking_reminder_ruleset_version is null');
    expect(sql).toContain('booking_reminder_contract_hash is not null');
    expect(sql).toContain("booking_reminder_contract_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('create table notifications.booking_reminder_schedules');
    expect(sql).not.toContain('create table if not exists');
    expect(sql).toContain('primary key (tenant_id, booking_id, reminder_kind)');
    expect(sql).toContain('unique (event_id)');
    expect(sql).toContain("reminder_kind in ('HOURS_24', 'HOURS_2')");
    expect(sql).toContain("state in ('PENDING', 'EMITTED', 'CANCELLED', 'MISSED', 'SUPERSEDED')");
    expect(sql).not.toContain('recipient_user_ids uuid[]');
    expect(sql).toContain('create table notifications.booking_reminder_recipients');
    expect(sql).toContain('recipient_position between 1 and 50');
    expect(sql).toContain(
      'foreign key (tenant_id, user_id) references identity.users(tenant_id, id)',
    );
    expect(sql).toContain('references notifications.booking_reminder_schedules');
    expect(sql).toContain("when 'HOURS_24' then interval '24 hours'");
    expect(sql).toContain("when 'HOURS_2' then interval '2 hours'");
    expect(sql).toContain("where state = 'PENDING'");
    expect(sql).toContain('create index booking_reminder_schedules_claim_idx');
    expect(sql).toContain("where state = 'PENDING' and claim_token is not null");
    expect(sql).toContain('create index booking_reminder_schedules_missed_idx');
    expect(sql).toContain("where state = 'MISSED'");
    expect(sql).toContain('booking_reminder_schedules_tenant_isolation');
    expect(sql).toContain('booking_reminder_recipients_tenant_isolation');
    expect(sql).toContain(
      "using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)",
    );
    expect(sql).toContain(
      'alter table notifications.booking_reminder_schedules force row level security',
    );
    expect(sql).toContain(
      'alter table notifications.booking_reminder_recipients force row level security',
    );
    expect(sql).not.toContain('insert into');
  });
});
