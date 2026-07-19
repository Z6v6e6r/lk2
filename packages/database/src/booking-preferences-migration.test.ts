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
});
