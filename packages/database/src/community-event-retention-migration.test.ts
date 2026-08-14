import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('community event retention migration', () => {
  it('backfills under FORCE RLS and adds durable bounded claims', async () => {
    const sql = await readFile(
      new URL('../migrations/0068_community_event_retention.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain("set_config('app.tenant_id', current_tenant_id::text, true)");
    expect(sql).toContain('retained_from_sequence bigint not null default 1');
    expect(sql).toContain('retention_due_at timestamptz');
    expect(sql).toContain('purge_claim_token uuid');
    expect(sql).toContain('purge_claim_expires_at timestamptz');
    expect(sql).toContain('community_event_head_purge_claim_pair_check');
    expect(sql).toContain('community_event_heads_retention_due_idx');
    expect(sql).toContain('community_event_heads_retention_due_repair_idx');
  });
});
