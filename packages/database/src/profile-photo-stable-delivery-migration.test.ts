import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('profile photo stable delivery migration', () => {
  it('adds and backfills an opaque delivery id without rewriting existing profile rows', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'packages/database/migrations/0039_profile_photo_stable_delivery.sql'),
      'utf8',
    );

    expect(sql).toContain('add column if not exists delivery_id uuid');
    expect(sql).toContain('set delivery_id = gen_random_uuid()');
    expect(sql).toContain('alter column delivery_id set not null');
    expect(sql).not.toContain('update profile.user_summaries');
    expect(sql).not.toContain('source_url');
  });
});
