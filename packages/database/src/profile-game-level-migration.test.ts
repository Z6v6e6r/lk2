import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('profile game level migration', () => {
  it('adds only a nullable constrained PadlHub level label', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0026_profile_game_level.sql'),
      'utf8',
    );

    expect(sql).toContain('add column level_label text');
    expect(sql).toContain("level_label in ('D', 'D+', 'C', 'C+', 'B', 'B+', 'A')");
    expect(sql).not.toMatch(/viva|external_id/i);
  });
});
