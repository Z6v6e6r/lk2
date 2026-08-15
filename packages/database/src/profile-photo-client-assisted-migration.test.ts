import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('client-assisted profile photo migration', () => {
  it('allows an absent provider URL without weakening the owned WebP mapping', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0079_profile_photo_client_assisted_source.sql',
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

  it('adds a validated idempotent delete command without a table rewrite default', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0082_profile_photo_removal_commands.sql',
      ),
      'utf8',
    );

    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("command_kind in ('UPSERT', 'DELETE')");
    expect(sql).toContain('profile_photo_client_commands_kind_check');
    expect(sql).toContain("command_kind = 'DELETE'");
    expect(sql).toContain('request_sha256 is null');
    expect(sql).toContain('object_key is null');
    expect(sql).toContain('not valid');
    expect(sql).not.toContain('validate constraint profile_photo_client_commands_payload_check');
    expect(sql).not.toMatch(/drop\s+(table|column)/i);

    const validationSql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0083_profile_photo_removal_commands_validate.sql',
      ),
      'utf8',
    );
    expect(validationSql).toContain("set local lock_timeout = '5s'");
    expect(validationSql).toContain("set local statement_timeout = '30s'");
    expect(validationSql).toContain(
      'validate constraint profile_photo_client_commands_payload_check',
    );
    expect(validationSql).toContain('validate constraint profile_photo_client_commands_kind_check');
  });
});
