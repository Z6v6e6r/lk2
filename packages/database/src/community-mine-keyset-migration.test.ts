import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community mine keyset migration', () => {
  it('adds an expand-only partial index matching the membership-owned cursor order', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0066_community_mine_keyset_index.sql'),
      'utf8',
    );

    expect(sql).toContain('community_memberships_mine_keyset_idx');
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('user_id');
    expect(sql).toContain('((pinned_at is not null)) desc');
    expect(sql).toContain('updated_at desc');
    expect(sql).toContain('community_id');
    expect(sql).toContain("where status = 'ACTIVE'");
    expect(sql).not.toMatch(/drop\s+(table|column|constraint)|truncate/i);
  });
});
