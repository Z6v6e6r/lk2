import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('client-assisted profile photo migration', () => {
  it('allows an absent provider URL without weakening the owned WebP mapping', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0074_profile_photo_client_assisted_source.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('alter column source_url drop not null');
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain('create table integration.profile_photo_client_commands');
    expect(sql).toContain('primary key (tenant_id, user_id, idempotency_key)');
    expect(sql).toContain('request_sha256');
    expect(sql).toContain('content_sha256');
    expect(sql).toContain('object_key');
    expect(sql).toContain('client_grant_issued_at');
    expect(sql).toContain('unique (tenant_id, user_id, grant_id)');
    expect(sql).toContain('profile_photo_client_commands_expiry_idx');
    expect(sql).toContain('profile_photo_client_commands_pending_object_idx');
    expect(sql).toContain('(tenant_id, object_key, expires_at)');
    expect(sql).toContain('where avatar_url is null');
    expect(sql).toContain('create table integration.profile_photo_observation_watermarks');
    expect(sql).toContain('profile_photo_observation_watermarks_tenant_isolation');
    expect(sql).toContain("[0-9a-f]{64}\\.webp$'");
    expect(sql).not.toContain("[0-9a-f]{64}\\\\.webp$'");
    expect(sql).toContain('force row level security');
    expect(sql).not.toMatch(/drop\s+column/i);
  });
});
