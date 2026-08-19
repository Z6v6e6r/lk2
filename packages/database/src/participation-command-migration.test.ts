import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(
    new URL('../migrations/0088_participation_command_foundation.sql', import.meta.url),
  ),
  'utf8',
);

describe('participation command foundation migration', () => {
  it('is expand-only and creates no writer trigger or feature activation', () => {
    expect(migration).toContain('create table eligibility.activity_level_projections');
    expect(migration).toContain('create table eligibility.participation_commands');
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
    expect(migration).not.toMatch(/create\s+trigger/i);
    expect(migration).not.toMatch(/insert\s+into\s+eligibility\.level_policies/i);
  });

  it('keeps provider identifiers in integration storage and canonical ids in eligibility', () => {
    expect(migration).toContain('references integration.external_entity_map(tenant_id, id)');
    expect(migration).not.toMatch(/external_(client|exercise|tournament)_id/i);
    expect(migration).toContain('foreign key (tenant_id, actor_user_id)');
    expect(migration).toContain('foreign key (tenant_id, decision_id)');
  });

  it('binds payment evidence, idempotency, expiry, and tenant isolation', () => {
    expect(migration).toContain('unique (tenant_id, principal_key, idempotency_key)');
    expect(migration).toContain('unique (tenant_id, payment_snapshot_operation_id)');
    expect(migration).toContain('unique (tenant_id, principal_key, writer_operation_id)');
    expect(migration).toContain('references eligibility.payment_snapshots');
    expect(migration).toContain("where state = 'AUTHORIZED'");
    expect(migration).toContain('force row level security');
    expect(migration.match(/force row level security/g)).toHaveLength(2);
  });
});
