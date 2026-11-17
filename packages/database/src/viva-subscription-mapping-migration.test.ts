import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Viva subscription owner migration', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'packages/database/migrations/0117_viva_subscription_owners.sql'),
    'utf8',
  );

  it('creates a tenant-isolated expand-only owner binding', () => {
    expect(sql).toContain('create table integration.viva_subscription_owners');
    expect(sql).toContain('tenant_id uuid not null references identity.tenants(id)');
    expect(sql).toContain('primary key (tenant_id, subscription_mapping_id)');
    expect(sql).toContain('references integration.external_entity_map(tenant_id, id)');
    expect(sql).toContain(
      'foreign key (tenant_id, user_id) references identity.users(tenant_id, id)',
    );
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).toContain('phub:reviewed-new-table-index');
    expect(sql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+integration\.external_entity_map\b/i);
  });

  it('keeps provider identifiers and personal data out of the binding', () => {
    for (const forbidden of ['external_id', 'phone', 'provider_client', 'title', 'payload']) {
      expect(sql.replace(/^--.*$/gm, '')).not.toContain(forbidden);
    }
  });
});
