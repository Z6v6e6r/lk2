import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community content migration', () => {
  it('adds tenant-isolated canonical content with bounded bodies and archive clocks', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0068_community_content_foundation.sql'),
      'utf8',
    );
    expect(sql).toContain('create schema if not exists community_content');
    expect(sql).toContain('char_length(body) between 1 and 10000');
    expect(sql).toContain('char_length(body) between 1 and 2000');
    expect(sql).toContain("restore_until = archived_at + interval '30 days'");
    expect(sql).toContain("retention_until = archived_at + interval '5 years'");
    expect(sql).toContain("reaction_type in ('LIKE', 'DISLIKE')");
    expect(sql).toContain('community_content_feed_keyset_idx');
    expect(sql.match(/force row level security/g)).toHaveLength(7);
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
