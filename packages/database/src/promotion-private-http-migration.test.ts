import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0049_promotion_media_private_http_sources.sql',
);

describe('promotion media private HTTP source migration', () => {
  it('keeps HTTPS support and limits HTTP to known development transports', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain("source_url ~ '^https://'");
    expect(sql).toContain('host\\.docker\\.internal');
    expect(sql).toContain('phab-showcase');
    expect(sql).not.toContain("source_url ~ '^http://'");
  });
});
