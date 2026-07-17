import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0023_games_foundation.sql',
);

const tenantTables = [
  'games.games',
  'games.participations',
  'games.seat_reservations',
  'games.waitlist_entries',
  'games.result_submissions',
  'games.result_submission_reviews',
  'games.results',
  'games.invitations',
  'games.operations',
  'games.card_projections',
  'games.command_idempotency',
  'games.scheduled_commands',
] as const;

describe('Games foundation migration', () => {
  it('forces tenant RLS on every Games-owned table', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    for (const table of tenantTables) {
      expect(sql).toContain(`alter table ${table} enable row level security;`);
      expect(sql).toContain(`alter table ${table} force row level security;`);
    }
    expect(sql).toContain("current_setting('app.tenant_id', true)");
  });

  it('uses tenant-aware references and concurrency constraints', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('references games.games(tenant_id, id)');
    expect(sql).toContain('references identity.users(tenant_id, id)');
    expect(sql).toContain('games_active_participation_user_idx');
    expect(sql).toContain('games_active_reservation_user_idx');
    expect(sql).toContain('games_active_waitlist_position_idx');
    expect(sql).toContain('unique (tenant_id, principal_key, idempotency_key)');
  });

  it('keeps provider identity outside Games and declares LOCAL_PRIMARY ownership', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const columnDefinitions = sql
      .split('\n')
      .filter((line) => /^\s{2}[a-z_]+\s/.test(line))
      .join('\n');

    expect(columnDefinitions).not.toMatch(/\b(viva|provider|external)_[a-z_]+\b/i);
    expect(sql).toContain("values (current_tenant_id, 'games', 'LOCAL_PRIMARY')");
  });
});
