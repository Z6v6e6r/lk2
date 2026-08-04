import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community DIRECT invite quota migration', () => {
  it('adds one-time grant evidence and rolling ISSUE indexes expand-only', async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'packages/database/migrations/0065_community_direct_invite_quotas.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('create table if not exists communities.direct_invite_quota_grants');
    expect(sql).toContain("capability = 'communities.invite.quota.override'");
    expect(sql).toContain("expires_at timestamptz not null default (now() + interval '24 hours')");
    expect(sql).toContain("where state = 'ACTIVE'");
    expect(sql).toContain('community_direct_invite_quota_grants_one_active_idx');
    expect(sql).toContain(
      'create table if not exists communities.direct_invite_quota_grant_commands',
    );
    expect(sql).toContain('add column if not exists community_id uuid');
    expect(sql).toContain('add column if not exists quota_grant_id uuid');
    expect(sql).toContain('community_direct_invite_commands_community_fk');
    expect(sql).toContain('community_direct_invite_commands_quota_grant_fk');
    expect(sql).toContain('community_direct_invite_commands_issue_window_idx');
    expect(sql).toContain('(tenant_id, community_id, created_at)');
    expect(sql).toContain("where command_type = 'ISSUE' and community_id is not null");
    expect(sql).toContain('community_direct_invite_commands_issue_legacy_window_idx');
    expect(sql).toContain("where command_type = 'ISSUE' and community_id is null");
    expect(sql).toContain('community_direct_invite_quota_grants_tenant_isolation');
    expect(sql).toContain('community_direct_invite_quota_grant_commands_tenant_isolation');
    expect(sql).not.toContain('quota_override_authorized_by_user_id');
    expect(sql).toContain('not valid');
    expect(sql).not.toMatch(/drop\s+(table|column|constraint)/i);
  });
});
