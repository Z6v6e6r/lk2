import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0040_game_results_v2.sql',
);

describe('Games result v2 migration', () => {
  it('normalizes confirmed set rosters and analytical player facts under tenant RLS', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    for (const table of [
      'games.result_sets',
      'games.result_set_players',
      'games.player_set_facts',
    ]) {
      expect(sql).toContain(`create table ${table}`);
      expect(sql).toContain(`alter table ${table} enable row level security;`);
      expect(sql).toContain(`alter table ${table} force row level security;`);
    }
    expect(sql).toContain('confirmation_quorum');
    expect(sql).toContain('references games.results(tenant_id, game_id, id)');
    expect(sql).toContain('references identity.users(tenant_id, id)');
    expect(sql).not.toMatch(/\b(viva|provider|external)_[a-z_]+\b/i);
  });
});
