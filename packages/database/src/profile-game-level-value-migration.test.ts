import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('profile game level value migration', () => {
  it('adds a nullable constrained normalized rating value', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0035_profile_game_level_value.sql'),
      'utf8',
    );

    expect(sql).toContain('add column level_value numeric(8, 5)');
    expect(sql).toContain('level_value >= 0 and level_value <= 10');
    expect(sql).not.toMatch(/external_id|phone|payment/i);
  });
});
