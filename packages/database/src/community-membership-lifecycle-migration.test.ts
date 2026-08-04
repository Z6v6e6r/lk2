import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community membership lifecycle migration', () => {
  it('adds durable tenant-isolated join requests and replay-safe commands', async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'packages/database/migrations/0063_community_membership_lifecycle.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('create table if not exists communities.join_requests');
    expect(sql).toContain("request_kind in ('JOIN', 'REJOIN')");
    expect(sql).toContain("origin_status in ('ABSENT', 'LEFT', 'REMOVED')");
    expect(sql).toContain('community_one_pending_join_request_idx');
    expect(sql).toContain("where status = 'PENDING'");
    expect(sql).toContain('create table if not exists communities.membership_lifecycle_commands');
    expect(sql).toContain('request_hash text not null');
    expect(sql).toContain('result_payload jsonb not null');
    expect(sql).toContain('force row level security');
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
