import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('phone login uniqueness migration', () => {
  it('replaces the non-unique phone lookup index with a unique one under the same name', async () => {
    const sql = await readFile(
      new URL('../migrations/0091_phone_login_uniqueness.sql', import.meta.url),
      'utf8',
    );

    // A duplicate phone would make phone sign-in impossible for those users, because the login path
    // refuses to guess between two matches. The schema must therefore reject the duplicate.
    expect(sql).toContain('create unique index if not exists user_summaries_phone_lookup_idx');
    expect(sql).toContain('on profile.user_summaries (tenant_id, phone_e164)');
    expect(sql).toContain('where phone_e164 is not null');
    // Same name as the index it replaces, so existing lookups keep using one index.
    expect(sql).toContain('drop index if exists profile.user_summaries_phone_lookup_idx');
    // Never relax the tenant scope, and never rebuild the whole table.
    expect(sql).not.toContain('drop constraint');
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('not valid');
    // Bounded lock behaviour, as required for the migration safety check.
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    // `create unique index` is non-concurrent, so it needs the reviewed marker.
    expect(sql).toContain('phub:reviewed-new-table-index');
  });
});
