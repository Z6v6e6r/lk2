import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('support ticket migration', () => {
  it('keeps the aggregate tenant-scoped and restricts auto-close to resolved tickets', async () => {
    const sql = await readFile(
      resolve(import.meta.dirname, '../migrations/0098_support_tickets.sql'),
      'utf8',
    );
    expect(sql).toContain('create table support.tickets');
    expect(sql).toContain("status in ('OPEN','IN_PROGRESS','WAITING_USER','RESOLVED','CLOSED')");
    for (const table of ['tickets', 'messages', 'history', 'commands']) {
      expect(sql).toContain(`alter table support.${table} enable row level security`);
      expect(sql).toContain(`alter table support.${table} force row level security`);
      expect(sql).toContain(
        `create policy support_${table}_tenant on support.${table} using(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)`,
      );
    }
    expect(sql).toContain('create table support.commands');
    expect(sql).toContain('primary key(tenant_id,actor_id,idempotency_key)');
    expect(sql).toContain("where status = 'RESOLVED'");
  });
});
