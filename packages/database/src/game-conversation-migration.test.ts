import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('0059 game conversations migration', () => {
  it('is tenant-scoped, forced-RLS and bound only to canonical games UUIDs', async () => {
    const sql = await readFile(
      new URL('../migrations/0059_game_conversations.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('references games.games(tenant_id, id)');
    expect(sql).toContain('references identity.users(tenant_id, id)');
    expect(sql).toContain('references messaging.conversations(tenant_id, id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).not.toMatch(/viva|external_id|provider_id/i);
  });
});
