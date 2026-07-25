import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0042_legacy_game_id_alias_merge.sql',
);

describe('legacy game ID alias merge migration', () => {
  it('keeps source aggregates as tenant-isolated lossless redirects', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('create table integration.legacy_game_merge_redirects');
    expect(sql).toContain('foreign key (tenant_id, source_game_id)');
    expect(sql).toContain('foreign key (tenant_id, target_game_id)');
    expect(sql).toContain('legacy_game_merge_redirects_tenant_isolation');
    expect(sql).toContain('force row level security');
    expect(sql).not.toContain('delete from games.games');
    expect(sql).not.toContain('delete from games.participations');
  });

  it('recognizes raw and pseudonymous IDs and moves visible/external references', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain("'phub-local-public-clone-v1:game:'");
    expect(sql).toContain('digest(');
    expect(sql).toContain("mapping.external_system = 'LK_LEGACY_SNAPSHOT'");
    expect(sql).toContain("mapping.external_system = 'VIVA'");
    expect(sql).toContain('update booking.activity_history_projection');
    expect(sql).toContain('delete from games.card_projections');
    expect(sql).toContain("set mode = 'DISABLED'");
    expect(sql).toContain('LEGACY_GAME_ALIAS_PAIR_MERGED');
  });

  it('keeps canonical internal mapping uniqueness outside the legacy alias scope', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('create unique index external_entity_map_canonical_internal_idx');
    expect(sql).toContain("external_system = 'LK_LEGACY_SNAPSHOT'");
    expect(sql).toContain("entity_type in ('game', 'game_player', 'game_station', 'game_court')");
  });
});
