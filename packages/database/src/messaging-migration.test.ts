import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('messaging runtime migration', () => {
  it('keeps all tenant gates off and enforces tenant isolation', async () => {
    const sql = await readFile(
      new URL('../migrations/0057_messaging_runtime.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('http_enabled boolean not null default false');
    expect(sql).toContain('direct_enabled boolean not null default false');
    expect(sql).toContain('realtime_enabled boolean not null default false');
    expect(sql).toContain('contextual_enabled boolean not null default false');
    expect(sql.match(/enable row level security/g)).toHaveLength(3);
    expect(sql.match(/force row level security/g)).toHaveLength(3);
    expect(sql).not.toMatch(/viva|external_id/i);
  });

  it('reconciles only the checksum-identical legacy migration after structural checks', async () => {
    const [aliasSql, runtimeSql] = await Promise.all([
      readFile(
        new URL('../migrations/0056_messaging_runtime_legacy_alias.sql', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../migrations/0057_messaging_runtime.sql', import.meta.url), 'utf8'),
    ]);
    const runtimeChecksum = createHash('sha256').update(runtimeSql).digest('hex');

    expect(aliasSql).toContain(`expected_checksum constant text := '${runtimeChecksum}'`);
    expect(aliasSql).toContain("filename = '0043_messaging_runtime.sql'");
    expect(aliasSql).toContain("filename = '0057_messaging_runtime.sql'");
    expect(aliasSql).toContain('if legacy_checksum is null then');
    expect(aliasSql).toContain('if legacy_checksum <> expected_checksum then');
    expect(aliasSql).toContain('matching_relations <> 3');
    expect(aliasSql).toContain('matching_columns <> 21');
    expect(aliasSql).toContain('matching_constraints <> 15');
    expect(aliasSql).toContain('matching_indexes <> 2');
    expect(aliasSql).toContain('matching_policies <> 3');
    expect(aliasSql).toContain('insert into public.schema_migrations (filename, checksum)');
    expect(aliasSql.match(/insert into/g)).toHaveLength(1);
    expect(aliasSql).not.toMatch(/\b(drop|truncate|delete|update)\b/i);
    expect(aliasSql).not.toMatch(/insert into (?!public\.schema_migrations)/i);
  });

  it('relies on the tenant-local direct-pair and message command uniqueness foundation', async () => {
    const sql = await readFile(
      new URL('../migrations/0007_chats_notifications.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('unique (tenant_id, left_user_id, right_user_id)');
    expect(sql).toContain('unique (tenant_id, conversation_id, sequence)');
    expect(sql).toContain('unique (tenant_id, conversation_id, client_message_id)');
    expect(sql).toContain('unique (tenant_id, conversation_id, idempotency_key)');
  });
});
