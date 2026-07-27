import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('profile level history migration', () => {
  it('creates a tenant-isolated immutable history and captures summary changes', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0044_profile_level_history.sql'),
      'utf8',
    );

    expect(sql).toContain('create table profile.level_history');
    expect(sql).toContain('profile_level_history_tenant_isolation');
    expect(sql).toContain('insert into profile.level_history');
    expect(sql).toContain('profile.capture_level_history()');
    expect(sql).toContain('after insert or update of level_label, level_value');
  });
});
