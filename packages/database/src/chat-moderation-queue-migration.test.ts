import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('chat moderation queue migration', () => {
  it('adds only the two queue indexes the review flow needs', async () => {
    const sql = await readFile(
      new URL('../migrations/0094_chat_moderation_queue.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('phub:reviewed-new-table-index');
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain('create index moderation_reports_queue_idx');
    expect(sql).toContain('on moderation.reports (tenant_id, state, created_at, id)');
    expect(sql).toContain('create index moderation_actions_case_idx');
    expect(sql).toContain('on moderation.actions (tenant_id, case_id, created_at)');
    // Expand-only: no destructive statement and no change to an existing constraint.
    expect(sql).not.toMatch(/\b(drop|truncate|delete|update|alter)\b/i);
    expect(sql).not.toContain('if not exists');
  });
});
