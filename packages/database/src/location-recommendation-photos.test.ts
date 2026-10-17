import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { createLocationRepository } from './location-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const locationId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-11T10:00:00.000Z');
const hours = (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const).map((weekday) => ({
  weekday,
  closed: false,
  intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
}));
const row = {
  id: locationId,
  slug: 'terekhovo',
  title: 'Терехово',
  short_title: 'Терехово',
  city: 'Москва',
  court_count: 4,
  address: 'Москва',
  latitude: 55.75,
  longitude: 37.5,
  timezone: 'Europe/Moscow',
  metro_name: null,
  metro_distance_meters: null,
  phone_e164: '+79990000000',
  working_hours: hours,
  amenities: [],
  gallery: [
    {
      url: 'https://cdn.padlhub.test/terekhovo.webp',
      alt: '',
      isCover: true,
      sortOrder: 0,
    },
  ],
  publication_status: 'PUBLISHED' as const,
  show_on_home: true,
  sort_order: 0,
  version: 1,
  created_at: now,
  updated_at: now,
  published_at: now,
  archived_at: null,
};

function publicReadPool(queries: string[]): Pool {
  const client = {
    query: (text: string) => {
      queries.push(text);
      if (text.includes('recommendation_card_photos')) {
        return Promise.reject(new Error('PUBLIC_READ_MUST_NOT_QUERY_RECOMMENDATION_PHOTOS'));
      }
      if (text.includes('from locations.profiles')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

describe('location published reads', () => {
  it('keeps public list and detail reads independent of recommendation photo storage', async () => {
    const queries: string[] = [];
    const repository = createLocationRepository(publicReadPool(queries));

    const listed = await repository.listPublished(tenantId, { homeOnly: true });
    const detail = await repository.getPublished(tenantId, locationId);

    expect(listed).toHaveLength(1);
    expect(detail).toMatchObject({ id: locationId, title: 'Терехово' });
    expect(queries.some((query) => query.includes('recommendation_card_photos'))).toBe(false);
  });
});
