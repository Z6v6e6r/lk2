import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('booking preferences migration', () => {
  it('creates a tenant-isolated local aggregate without provider or subscription coupling', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0027_booking_preferences.sql'),
      'utf8',
    );

    expect(sql).toContain('create table profile.booking_preferences');
    expect(sql).toContain('create table profile.booking_preference_commands');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("'booking_preferences', 'LOCAL_ONLY'");
    expect(sql).not.toMatch(/viva_id|external_id|subscription_id/i);
  });

  it('expands preferences with presentation and friend-aware defaults', async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'packages/database/migrations/0048_booking_preference_presentation_and_friends.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('recommend_friends boolean not null default true');
    expect(sql).toContain("recommendation_display text not null default 'CARDS'");
    expect(sql).toContain("recommendation_display in ('CARDS', 'ROWS')");
  });
});
