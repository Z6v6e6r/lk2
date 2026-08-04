import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community content moderation migration', () => {
  it('adds tenant-isolated command/evidence state and a bounded pending queue index', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0070_community_content_moderation.sql'),
      'utf8',
    );
    expect(sql).toContain('community_content.moderation_commands');
    expect(sql).toContain('community_content.moderation_actions');
    expect(sql).toContain("where status = 'PENDING_MODERATION'");
    expect(sql).toContain("reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'");
    expect(sql.match(/force row level security/g)).toHaveLength(2);
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
