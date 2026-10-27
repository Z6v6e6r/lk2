import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/database/migrations/0104_identity_external_subject_link_commands.sql',
);

describe('0104 external subject link command receipt migration', () => {
  it('is additive, tenant-bound, forced-RLS and contains no runtime grant', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('create table identity.external_subject_link_commands');
    expect(sql).toContain("check (purpose = 'SUBJECT_LINK')");
    expect(sql).toContain("check (audience = 'client')");
    expect(sql).toContain('foreign key (tenant_id, actor_user_id)');
    expect(sql).toContain('unique (tenant_id, command_key_hash)');
    expect(sql).toContain('unique (tenant_id, challenge_id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+(?!identity\.external_subject_link_commands)/i);
  });
});
