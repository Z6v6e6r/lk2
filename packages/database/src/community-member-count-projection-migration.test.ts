import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('community member-count projection migration', () => {
  it('creates a rebuildable, tenant-isolated projection with explicit readiness', async () => {
    const sql = await readFile(
      new URL('../migrations/0071_community_member_count_projection.sql', import.meta.url),
      'utf8',
    );
    for (const table of [
      'communities.member_count_projections',
      'communities.member_count_contributions',
    ]) {
      expect(sql).toContain(`create table if not exists ${table}`);
      expect(sql).toContain(`alter table ${table} force row level security`);
    }
    expect(sql).toContain("state in ('BUILDING', 'READY', 'STALE')");
    expect(sql).toContain('reconciliation_cursor uuid');
    expect(sql).toContain('membership_revision bigint');
    expect(sql).not.toMatch(/alter table communities\.communities\s+add column/i);
    expect(sql).not.toMatch(/update communities\.communities/i);
  });
});
