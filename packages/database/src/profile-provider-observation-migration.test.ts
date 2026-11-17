import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('profile provider observation migration', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'packages/database/migrations/0116_profile_provider_observations.sql'),
    'utf8',
  );

  it('creates a tenant-isolated expand-only observation table', () => {
    expect(sql).toContain('create table profile.provider_observations');
    expect(sql).toContain('tenant_id uuid not null references identity.tenants(id)');
    expect(sql).toContain('foreign key(tenant_id,user_id) references identity.users(tenant_id,id)');
    expect(sql).toContain('primary key(tenant_id,user_id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain('provider_observation_tenant_isolation');
    expect(sql).toContain("current_setting('app.tenant_id',true)");
    expect(sql).not.toMatch(/drop\s+(table|column)/i);
    expect(sql).not.toMatch(/truncate/i);
  });

  it('keeps provider identity, tokens and personal data out of the row', () => {
    for (const forbidden of [
      'provider_user_id',
      'external_id',
      'access_token',
      'refresh_token',
      'phone',
      'photo',
      'first_name',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('stores only readable provider level and balance values', () => {
    expect(sql).toContain('level_label in');
    expect(sql).toContain('level_value numeric(8,5)');
    expect(sql).toContain('level_value>=0 and level_value<=10');
    expect(sql).toContain('balance_minor bigint');
    expect(sql).toContain('currency text not null default');
    expect(sql).toContain("currency='RUB'");
    expect(sql).toContain('observed_at timestamptz not null');
    expect(sql).toContain('check((level_label is null)=(level_value is null))');
    // The balance and level stay nullable: an unreadable provider field is omitted, not zeroed.
    expect(sql).not.toContain('balance_minor bigint not null');
  });
});
