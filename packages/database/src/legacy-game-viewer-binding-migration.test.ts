import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('legacy game viewer binding migration', () => {
  it('stores only a one-way association with tenant RLS', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0038_legacy_game_viewer_bindings.sql'),
      'utf8',
    );

    expect(sql).toContain('create table integration.legacy_game_player_bindings');
    expect(sql).toContain("source_player_association_id ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("proof_kind in ('VIVA_PROFILE', 'VIEWER_PHONE')");
    expect(sql).toContain(
      'alter table integration.legacy_game_player_bindings force row level security;',
    );
    expect(sql).not.toMatch(/phone_e164|viva_exercise|external_id text/i);
  });
});
