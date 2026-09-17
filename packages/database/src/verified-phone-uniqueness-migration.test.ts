import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('verified phone uniqueness migration', () => {
  it('fails on duplicate phones before replacing the lookup index with the unique equivalent', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0091_verified_phone_uniqueness.sql'),
      'utf8',
    );

    // The guard must run before the index build and must name the failure mode.
    expect(sql).toContain('verified_phone_duplicate');
    expect(sql.indexOf('raise exception')).toBeLessThan(
      sql.indexOf('create unique index if not exists user_summaries_phone_lookup_idx'),
    );
    expect(sql).toContain('group by tenant_id, phone_e164');
    expect(sql).toContain('having count(*) > 1');
    expect(sql).not.toMatch(/phone_e164\s+is\s+null\s+or/i);

    // Same index name and predicate as the non-unique lookup index it replaces.
    expect(sql).toContain('drop index if exists profile.user_summaries_phone_lookup_idx');
    expect(sql).toContain('on profile.user_summaries (tenant_id, phone_e164)');
    expect(sql).toContain('where phone_e164 is not null');

    // Expand-only: no destructive statement and no column change.
    expect(sql).not.toMatch(/drop\s+(table|column)|alter\s+column|truncate/i);
    expect(sql).not.toContain('not valid');
    expect(sql).not.toMatch(/select\s+phone_e164\s+from/i);
  });
});
