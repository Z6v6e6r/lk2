import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('upcoming bookings projection migration', () => {
  it('creates a tenant-isolated projection with forced RLS', async () => {
    const sql = await readFile(
      new URL('../migrations/0052_upcoming_bookings_projection.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('create table booking.upcoming_booking_projection');
    expect(sql).toContain('foreign key (tenant_id, user_id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("current_setting('app.tenant_id'");
  });
});
