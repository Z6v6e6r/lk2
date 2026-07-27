import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community member rank migration', () => {
  it('adds an optional positive ranking position to canonical memberships', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0043_community_member_rank.sql'),
      'utf8',
    );

    expect(sql).toContain('alter table communities.memberships');
    expect(sql).toContain('add column ranking_position integer');
    expect(sql).toContain('ranking_position > 0');
  });
});
