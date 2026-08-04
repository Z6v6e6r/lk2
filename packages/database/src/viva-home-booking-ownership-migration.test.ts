import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Viva Home booking ownership migration', () => {
  it('keeps provider identifiers inside a tenant-isolated integration table', () => {
    const sql = readFileSync(
      new URL('../migrations/0060_viva_home_booking_ownership.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('create table integration.viva_home_booking_ownership');
    expect(sql).toContain('booking_external_id text not null');
    expect(sql).toContain('exercise_external_id text not null');
    expect(sql).toContain('foreign key (tenant_id, user_id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
  });
});
