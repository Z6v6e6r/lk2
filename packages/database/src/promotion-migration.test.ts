import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0025_home_promotions_legacy_bridge.sql',
);

describe('Home promotions legacy bridge migration', () => {
  it('keeps producer and media state tenant-scoped with forced RLS', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    for (const table of [
      'promotion_home_source_components',
      'promotion_media_sync',
      'promotion_media_object_gc',
    ]) {
      expect(sql).toContain(`alter table integration.${table} enable row level security`);
      expect(sql).toContain(`alter table integration.${table} force row level security`);
      expect(sql).toContain(`create policy ${table}_tenant_isolation`);
    }
  });

  it('stores only PadlHub media keys and bounded Home decks', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain("jsonb_array_length(payload -> 'items') <= 20");
    expect(sql).toContain('promotion-media/');
    expect(sql).toContain('desktop_delivery_url');
    expect(sql).toContain('mobile_delivery_url');
    expect(sql).not.toMatch(/image_data|bytea|external_id/);
  });
});
