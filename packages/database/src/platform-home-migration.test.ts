import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0028_platform_home_source.sql',
);

describe('platform Home source migration', () => {
  it('stores only tenant-scoped normalized components under forced RLS', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('primary key (tenant_id, user_id, component)');
    expect(sql).toContain("component in ('messaging', 'navigation', 'capabilities')");
    expect(sql).toContain(
      'alter table integration.platform_home_source_components enable row level security',
    );
    expect(sql).toContain(
      'alter table integration.platform_home_source_components force row level security',
    );
    expect(sql).toContain('create policy platform_home_source_components_tenant_isolation');
    expect(sql).not.toMatch(/external_id|viva_id|refresh_token/);
  });

  it('backfills only the missing LOCAL_ONLY location projection revision', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('insert into locations.home_projection_state');
    expect(sql).toContain('on conflict (tenant_id) do nothing');
  });
});
