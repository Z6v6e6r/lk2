import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('location media migration', () => {
  it('keeps uploaded gallery metadata tenant-isolated and stores only WebP object keys', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0033_location_media.sql'),
      'utf8',
    );

    for (const table of ['media_assets', 'media_commands']) {
      expect(sql).toContain(`alter table locations.${table} enable row level security;`);
      expect(sql).toContain(`alter table locations.${table} force row level security;`);
    }
    expect(sql).toContain("object_key ~ '^location-media/[0-9a-f-]{36}/[0-9a-f]{64}\\.webp$'");
    expect(sql).toContain("content_type = 'image/webp'");
    expect(sql).toContain('unique (tenant_id, content_sha256)');
  });
});
