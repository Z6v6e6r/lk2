import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('messaging user blocks migration', () => {
  it('stores directed tenant-local blocks and idempotent commands behind forced RLS', async () => {
    const sql = await readFile(
      new URL('../migrations/0071_messaging_user_blocks.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain('phub:reviewed-new-table-index');
    expect(sql).toContain('create table messaging.user_blocks');
    expect(sql).toContain('primary key (tenant_id, blocker_user_id, blocked_user_id)');
    expect(sql).toContain('create table messaging.user_block_commands');
    expect(sql).toContain('primary key (tenant_id, actor_user_id, idempotency_key)');
    expect(sql).toContain("action in ('BLOCK', 'UNBLOCK')");
    expect(sql.match(/enable row level security/g)).toHaveLength(2);
    expect(sql.match(/force row level security/g)).toHaveLength(2);
    expect(sql).not.toContain('if not exists');
    expect(sql).not.toMatch(/\b(drop|truncate)\b/i);
  });
});
