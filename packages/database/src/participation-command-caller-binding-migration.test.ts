import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('participation command caller binding migration', () => {
  it('adds the caller key as an expand-only, re-appliable column', async () => {
    const sql = await readFile(
      new URL('../migrations/0090_participation_command_caller_binding.sql', import.meta.url),
      'utf8',
    );

    // Expand-only: the column is nullable so existing rows and the current contract keep working,
    // and the migration can be re-applied without failing.
    expect(sql).toContain('alter table eligibility.participation_commands');
    expect(sql).toContain('add column if not exists caller_key text');
    expect(sql).toContain('create index if not exists participation_commands_caller_idx');
    // The digest format is pinned so a raw credential can never be stored in this column.
    expect(sql).toContain("caller_key ~ '^[0-9a-f]{64}$'");
    // A contract-step drop must not be part of the expand release.
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('drop not null');
    expect(sql).not.toContain('insert into');
    // Tenant isolation is already enforced on the table by 0088; this must not weaken it.
    expect(sql).not.toContain('disable row level security');
    expect(sql).not.toContain('nocreate');
  });
});
