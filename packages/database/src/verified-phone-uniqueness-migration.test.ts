import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('verified phone uniqueness migration', () => {
  it('fails on duplicate phones before replacing the lookup index with the unique equivalent', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0091_verified_phone_uniqueness.sql'),
      'utf8',
    );

    // The guard must run before the index build and must name the failure mode and both counts.
    expect(sql).toContain('verified_phone_duplicate');
    expect(sql.match(/raise exception/gu)).toHaveLength(1);
    expect(sql.indexOf('raise exception')).toBeGreaterThan(0);
    expect(sql.indexOf('raise exception')).toBeLessThan(
      sql.indexOf('drop index if exists profile.user_summaries_phone_lookup_idx'),
    );
    expect(sql).toContain('group by tenant_id, phone_e164');
    expect(sql).toContain('having count(*) > 1');
    expect(sql).toContain('count(distinct tenant_id), count(*)');
    expect(sql).not.toMatch(/phone_e164\s+is\s+null\s+or/i);

    // Same index name and predicate as the non-unique lookup index it replaces, and the predicate
    // must belong to the index statement rather than to the guard.
    expect(sql).toContain('drop index if exists profile.user_summaries_phone_lookup_idx');
    const indexStatement = sql.slice(
      sql.indexOf('create unique index if not exists user_summaries_phone_lookup_idx'),
    );
    expect(indexStatement).toContain('on profile.user_summaries (tenant_id, phone_e164)');
    expect(indexStatement).toContain('where phone_e164 is not null');
    expect(indexStatement.length).toBeLessThan(220);

    // The blocking-index marker is what makes the migration linter enforce the timeouts.
    expect(sql).toContain('-- phub:reviewed-blocking-index');
    expect(sql).not.toContain('-- phub:reviewed-new-table-index');
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("set local statement_timeout = '30s';");
    // Rollback is documented, because reverting an applied migration is silent ledger drift.
    expect(sql).toContain('Rollback:');
    expect(sql).toContain('0017_admin_notification_campaigns.sql');

    // Expand-only: no destructive statement and no column change.
    expect(sql).not.toMatch(/drop\s+(table|column)|alter\s+column|truncate/i);
    expect(sql).not.toContain('not valid');
    expect(sql).not.toMatch(/select\s+phone_e164\s+from/i);
  });
});
