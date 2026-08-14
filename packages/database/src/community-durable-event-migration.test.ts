import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community durable event migration', () => {
  it('adds a tenant-isolated monotonic recovery stream without destructive DDL', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0064_community_durable_events.sql'),
      'utf8',
    );
    expect(sql).toContain('create table if not exists community_content.event_heads');
    expect(sql).toContain('last_sequence bigint not null default 0');
    expect(sql).toContain('create table if not exists community_content.events');
    expect(sql).toContain('primary key (tenant_id, community_id, sequence)');
    expect(sql).toContain('target_revision bigint not null');
    expect(sql.match(/force row level security/g)).toHaveLength(2);
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
