import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community ownership transfer migration', () => {
  it('adds an expand-only tenant-isolated replay record', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0062_community_ownership_transfers.sql'),
      'utf8',
    );
    expect(sql).toContain('create table if not exists communities.ownership_transfer_commands');
    expect(sql).toContain('expected_owner_revision bigint not null');
    expect(sql).toContain('expected_target_revision bigint not null');
    expect(sql).toContain('result_payload jsonb not null');
    expect(sql).toContain('force row level security');
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
