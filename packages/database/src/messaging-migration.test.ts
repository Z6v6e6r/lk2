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
