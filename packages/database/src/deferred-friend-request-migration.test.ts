import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('deferred friend request migration', () => {
  it('stores a one-way association with tenant RLS and guarded states', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0092_deferred_friend_requests.sql'),
      'utf8',
    );

    expect(sql).toContain('create table profile.deferred_friend_requests');
    expect(sql).toContain("source_player_association_id ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("state in ('PENDING', 'DELIVERED', 'CANCELLED')");
    expect(sql).toContain('alter table profile.deferred_friend_requests force row level security;');
    expect(sql).toContain('create policy profile_deferred_friend_requests_tenant_isolation');
    expect(sql).toContain('references profile.friend_requests(tenant_id, id)');
    expect(sql).toContain('create unique index deferred_friend_requests_pending_pair_idx');
    expect(sql).toContain('create index deferred_friend_requests_pending_association_idx');
    expect(sql).toContain('deferred_friend_requests (tenant_id, source_player_association_id)');
    expect(sql).not.toMatch(/phone_e164|external_id text|viva_profile/i);
  });

  it('marks every new index for review and keeps the settle check closed', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0092_deferred_friend_requests.sql'),
      'utf8',
    );

    const indexStatements = sql.match(/create (?:unique )?index/g) ?? [];
    const reviewMarkers = sql.match(/-- phub:reviewed-new-table-index/g) ?? [];
    expect(reviewMarkers).toHaveLength(indexStatements.length);
    expect(sql).not.toContain('phub:reviewed-blocking-index');
    expect(sql).toContain("state = 'DELIVERED'");
    expect(sql).toContain("settled_reason = 'WITHDRAWN'");
  });
});
