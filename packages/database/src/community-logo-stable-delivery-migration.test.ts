import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community logo stable delivery migration', () => {
  it('relaxes only legacy signed-delivery metadata and preserves the object mapping', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0075_community_logo_stable_delivery.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('alter column delivery_url drop not null');
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain('alter column delivery_expires_at drop not null');
    expect(sql).toContain('community_logo_sync_delivery_pair_chk');
    expect(sql).toContain('create table integration.community_logo_observation_watermarks');
    expect(sql).toContain('community_logo_observation_watermarks_tenant_isolation');
    expect(sql).toContain('create table integration.media_cutover_state');
    expect(sql).toContain("check (feature in ('community_logo_stable_delivery'))");
    expect(sql).toContain('not valid');
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/update\s+integration\.community_logo_sync/i);
  });

  it('validates the delivery pair invariant in a separate migration', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'packages/database/migrations/0076_community_logo_stable_delivery_validate.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('validate constraint community_logo_sync_delivery_pair_chk');
    expect(sql).toContain("set local lock_timeout = '5s'");
  });
});
