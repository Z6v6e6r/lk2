import { describe, expect, it } from 'vitest';

import {
  buildLocationDetail,
  locationCompleteness,
  locationProfileInputSchema,
  slugifyLocationTitle,
  type LocationAdminView,
  type LocationProfileInput,
} from './index.js';

const hours = (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const).map((weekday) => ({
  weekday,
  closed: false,
  intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
}));

const input: LocationProfileInput = {
  slug: 'hub-nagatinskaya',
  title: 'Хаб Нагатинская',
  shortTitle: 'Нагатинская',
  city: 'Москва',
  courtCount: 6,
  address: '1-й Нагатинский проезд, 2',
  latitude: 55.6801,
  longitude: 37.6319,
  timezone: 'Europe/Moscow',
  metroName: 'Нагатинская',
  metroDistanceMeters: 400,
  phoneE164: '+79990000000',
  workingHours: hours,
  amenities: [],
  gallery: [
    {
      url: 'https://cdn.padlhub.test/nagatinskaya.webp',
      alt: 'Корты Нагатинской',
      isCover: true,
      sortOrder: 0,
    },
  ],
  publicationStatus: 'PUBLISHED',
  showOnHome: true,
  sortOrder: 10,
};

describe('location profile contract', () => {
  it('requires one cover and all publication-critical fields', () => {
    expect(locationProfileInputSchema.parse(input)).toEqual(input);
    expect(locationCompleteness(input)).toEqual({
      percent: 100,
      readyToPublish: true,
      missingFields: [],
    });
    expect(
      locationProfileInputSchema.safeParse({
        ...input,
        gallery: [{ ...input.gallery[0], isCover: false }],
      }).success,
    ).toBe(false);
  });

  it('computes open state and navigation without exposing an external station id', () => {
    const detail = buildLocationDetail(
      {
        id: '11111111-1111-4111-8111-111111111111',
        ...input,
        version: 2,
        completeness: locationCompleteness(input),
        createdAt: '2026-07-17T08:00:00.000Z',
        updatedAt: '2026-07-17T08:00:00.000Z',
        publishedAt: '2026-07-17T08:00:00.000Z',
        archivedAt: null,
      } satisfies LocationAdminView,
      new Date('2026-07-17T09:00:00.000Z'),
    );
    expect(detail.openNow).toBe(true);
    expect(detail.workingHoursSummary).toBe('Ежедневно, 07:00—23:00');
    expect(detail.navigationUrl).toContain('55.6801,37.6319');
    expect(detail).not.toHaveProperty('stationId');
  });

  it('builds a stable URL slug from a Russian title', () => {
    expect(slugifyLocationTitle('Хаб Нагатинская Премиум')).toBe('hab-nagatinskaya-premium');
  });

  it('rejects unsafe image URLs and invalid IANA timezones', () => {
    expect(
      locationProfileInputSchema.safeParse({
        ...input,
        gallery: [{ ...input.gallery[0]!, url: 'http://cdn.padlhub.test/location.webp' }],
      }).success,
    ).toBe(false);
    expect(
      locationProfileInputSchema.safeParse({ ...input, timezone: 'Moscow/Nowhere' }).success,
    ).toBe(false);
  });

  it('keeps an overnight interval open after midnight in the location timezone', () => {
    const overnight: LocationProfileInput = {
      ...input,
      workingHours: hours.map((entry) =>
        entry.weekday === 'MON'
          ? { ...entry, intervals: [{ opensAt: '22:00', closesAt: '02:00' }] }
          : entry,
      ),
    };
    const detail = buildLocationDetail(
      {
        id: '11111111-1111-4111-8111-111111111111',
        ...overnight,
        version: 1,
        completeness: locationCompleteness(overnight),
        createdAt: '2026-07-13T12:00:00.000Z',
        updatedAt: '2026-07-13T12:00:00.000Z',
        publishedAt: '2026-07-13T12:00:00.000Z',
        archivedAt: null,
      },
      new Date('2026-07-13T22:30:00.000Z'),
    );

    expect(detail.openNow).toBe(true);
    expect(detail.workingHoursSummary).toBe('Открыто до 02:00');
  });
});
