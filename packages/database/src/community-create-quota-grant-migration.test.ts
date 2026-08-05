import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community create quota grant migration', () => {
  it('adds tenant-isolated one-use user grants and links successful create commands', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0074_community_create_quota_grants.sql'),
      'utf8',
    );
    expect(sql).toContain('create table if not exists communities.create_quota_grants');
    expect(sql).toContain("'DAILY_CREATE_LIMIT'");
    expect(sql).toContain("'ACTIVE_OWNER_LIMIT'");
    expect(sql).toContain("capability = 'communities.create.quota.override'");
    expect(sql).toContain('consumed_by_community_id');
    expect(sql).toContain('create table if not exists communities.create_quota_grant_commands');
    expect(sql).toContain('community_create_quota_grants_one_active_user_idx');
    expect(sql).toContain('add column if not exists quota_grant_id uuid');
    expect(sql).toContain('foreign key (tenant_id, actor_user_id, quota_grant_id)');
    expect(sql).toContain('create_quota_grants_tenant_isolation');
    expect(sql).toContain('force row level security');
  });
});
