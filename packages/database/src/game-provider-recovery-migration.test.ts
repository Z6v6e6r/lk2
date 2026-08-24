import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/0090_game_provider_recovery.sql', import.meta.url)),
  'utf8',
);

describe('game provider recovery migration', () => {
  it('is expand-only, default-off, and cannot represent a live provider', () => {
    expect(migration).toContain("provider text not null check (provider = 'SYNTHETIC')");
    expect(migration).toContain("provider_contract_version = 'synthetic-v1'");
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
    expect(migration).not.toMatch(/create\s+trigger/i);
    expect(migration).not.toMatch(/insert\s+into\s+.*(feature|policy|flag)/i);
  });

  it('binds intent to tenant, actor, game, reservation, command and immutable eligibility facts', () => {
    for (const fragment of [
      'references games.command_idempotency(tenant_id, id)',
      'references identity.users(tenant_id, id)',
      'references games.games(tenant_id, id)',
      'references games.seat_reservations(tenant_id, game_id, id)',
      'references eligibility.decisions(tenant_id, id)',
      'references eligibility.payment_snapshots(tenant_id, operation_id)',
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain('unique (tenant_id, source_command_id, action)');
    expect(migration).toContain('unique (tenant_id, provider, provider_idempotency_key)');
  });

  it('has explicit uncertainty, bounded attempts, durable leases and immutable journals', () => {
    expect(migration).toContain("'READY', 'SUBMITTING', 'UNKNOWN', 'RECONCILING'");
    expect(migration).toContain("'CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'");
    expect(migration).toContain('submit_attempts between 0 and 20');
    expect(migration).toContain('readback_attempts between 0 and 20');
    expect(migration).toContain('lease_token uuid');
    expect(migration).toContain('create table integration.game_provider_operation_attempts');
    expect(migration).toContain(
      "event_type text not null check (event_type in ('STARTED', 'FINISHED'))",
    );
    expect(migration).toContain(
      'unique (tenant_id, operation_id, phase, attempt_number, event_type)',
    );
    expect(migration).toContain('create table integration.game_provider_operation_observations');
    expect(migration).toContain('unique (tenant_id, provider, dedupe_key)');
  });

  it('enforces tenant isolation on all three new tables', () => {
    expect(migration.match(/enable row level security/g)).toHaveLength(3);
    expect(migration.match(/force row level security/g)).toHaveLength(3);
    expect(migration.match(/current_setting\('app\.tenant_id'/g)).toHaveLength(6);
  });
});
