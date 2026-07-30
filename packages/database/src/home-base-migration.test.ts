import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('HomeBase projection migration', () => {
  it('creates an expand-only tenant-isolated partial snapshot', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0046_home_base_projection.sql'),
      'utf8',
    );

    expect(sql).toContain('create table home.base_snapshots');
    expect(sql).toContain("payload #>> '{snapshot,completeness}' = 'PARTIAL'");
    expect(sql).toContain("payload #>> '{viewerUserId}' = user_id::text");
    expect(sql).toContain("check (not (payload ? 'profile'))");
    expect(sql).toContain('checked_at timestamptz not null default now()');
    expect(sql).toContain('(tenant_id, checked_at, user_id)');
    expect(sql).toContain('alter table home.base_snapshots force row level security;');
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b/i);
  });
});
