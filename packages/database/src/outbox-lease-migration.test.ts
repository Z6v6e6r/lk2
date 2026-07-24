import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('outbox publish lease migration', () => {
  it('adds nullable lease metadata and a tenant-first unpublished index', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0031_outbox_publish_leases.sql'),
      'utf8',
    );

    expect(sql).toContain('add column if not exists publish_claim_token uuid');
    expect(sql).toContain('add column if not exists publish_claim_expires_at timestamptz');
    expect(sql).toContain('on audit.outbox_events (tenant_id, occurred_at, id)');
    expect(sql).toContain('where published_at is null');
    expect(sql).not.toMatch(/drop\s+(table|column)|alter\s+column[^;]+not\s+null/i);
  });
});
