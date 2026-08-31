import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('GAME notification projection fence migration', () => {
  it('adds an expand-only tenant-scoped aggregate revision fence', async () => {
    const sql = await readFile(
      new URL('../migrations/0089_game_notification_projection_fence.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('create table notifications.game_notification_projection_fences');
    expect(sql).not.toContain('if not exists');
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain(
      "game_revision numeric not null check (game_revision::text ~ '^[1-9][0-9]*$')",
    );
    expect(sql).toContain("'game.participation.confirmed.v1'");
    expect(sql).toContain("'game.participation.left.v1'");
    expect(sql).toContain("'game.cancelled.v1'");
    expect(sql).toContain("game_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('recipient_user_id uuid not null');
    expect(sql).toContain('primary key (tenant_id, game_id, recipient_user_id)');
    expect(sql).toContain('references identity.tenants(id)');
    expect(sql).toContain(
      'alter table notifications.game_notification_projection_fences enable row level security',
    );
    expect(sql).toContain('create policy game_notification_projection_fences_tenant_isolation');
    expect(sql).toContain('on notifications.game_notification_projection_fences');
    expect(sql).toContain(
      "using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)",
    );
    expect(sql).toContain(
      "with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)",
    );
    expect(sql).toContain(
      'alter table notifications.game_notification_projection_fences force row level security',
    );
    expect(sql).not.toContain('insert into');
    expect(sql).not.toContain('tenant_runtime_settings');
    expect(sql).not.toContain('trigger_rules');
  });
});
