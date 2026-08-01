import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('trainer avatar cache migration', () => {
  it('separates the trainer projection from provider identities and forces tenant RLS', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0050_trainer_avatar_cache.sql'),
      'utf8',
    );

    expect(sql).toContain('create table if not exists catalog.trainers');
    expect(sql).toContain('create table if not exists integration.trainer_avatar_sync');
    expect(sql).toContain('provider_trainer_id text not null');
    expect(sql).toContain("object_key ~ '^trainer-avatars/");
    for (const table of ['catalog.trainers', 'integration.trainer_avatar_sync']) {
      expect(sql).toContain(`alter table ${table} enable row level security;`);
      expect(sql).toContain(`alter table ${table} force row level security;`);
    }
  });
});
