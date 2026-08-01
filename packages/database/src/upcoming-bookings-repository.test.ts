import { describe, expect, it, vi } from 'vitest';

import { createUpcomingBookingsRepository } from './upcoming-bookings-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const generatedAt = '2026-08-01T20:00:00.000Z';
const staleAt = '2026-08-01T20:01:00.000Z';

function row() {
  return {
    tenant_id: tenantId,
    user_id: userId,
    version: 'a'.repeat(64),
    generated_at: generatedAt,
    stale_at: staleAt,
    items: [],
    updated_at: generatedAt,
  };
}

function repositoryWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve(handler(text, values));
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
  return { repository: createUpcomingBookingsRepository(pool as never), query };
}

describe('Upcoming bookings projection repository', () => {
  it('reads the tenant-scoped user projection', async () => {
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('from booking.upcoming_booking_projection')) return { rows: [row()] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.get(tenantId, userId)).resolves.toMatchObject({
      tenantId,
      userId,
      version: 'a'.repeat(64),
      generatedAt,
      staleAt,
      items: [],
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('atomically replaces the normalized projection', async () => {
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('insert into booking.upcoming_booking_projection')) {
        return { rows: [row()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.replace({
        tenantId,
        userId,
        version: 'a'.repeat(64),
        generatedAt,
        staleAt,
        items: [],
      }),
    ).resolves.toMatchObject({ tenantId, userId, items: [] });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('on conflict (tenant_id, user_id) do update'),
      ),
    ).toBe(true);
  });
});
