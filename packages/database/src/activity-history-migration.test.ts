import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0037_user_activity_history.sql',
);

describe('User activity history migration', () => {
  it('creates a tenant-owned projection and sync state with forced RLS', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    for (const table of [
      'booking.activity_history_projection',
      'integration.user_activity_history_sync_state',
    ]) {
      expect(sql).toContain(`alter table ${table} enable row level security;`);
      expect(sql).toContain(`alter table ${table} force row level security;`);
    }
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).toContain('references identity.users(tenant_id, id)');
  });

  it('keeps provider identity in integration storage and links local aggregates by UUID', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const projectionDefinition = sql.slice(
      sql.indexOf('create table booking.activity_history_projection'),
      sql.indexOf('create unique index activity_history_source_mapping_idx'),
    );
    const columnDefinitions = projectionDefinition
      .split('\n')
      .filter((line) => /^ {2}[a-z_]+\s/.test(line))
      .join('\n');

    expect(columnDefinitions).not.toMatch(/\b(viva|provider|external)_[a-z_]+\b/i);
    expect(sql).toContain('references integration.external_entity_map(tenant_id, id)');
    expect(sql).toContain('references games.games(tenant_id, id)');
    expect(sql).toContain("game_id is null or kind = 'GAME'");
    expect(sql).toContain("tournament_id is null or kind = 'TOURNAMENT'");
  });

  it('supports stable keyset order and a complete empty history marker', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('(tenant_id, user_id, occurred_at desc, id desc)');
    expect(sql).toContain("coverage_status in ('UNSYNCED', 'PARTIAL', 'COMPLETE')");
    expect(sql).toContain("coverage_status = 'COMPLETE'");
    expect(sql).toContain('check (ends_at is null or ends_at > starts_at)');
    expect(sql).not.toContain(
      "coverage_status = 'COMPLETE'\n+      and oldest_synced_at is not null",
    );
  });
});
