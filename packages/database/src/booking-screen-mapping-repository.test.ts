import { describe, expect, it, vi } from 'vitest';

import { createBookingScreenMappingRepository } from './booking-screen-mapping-repository.js';

describe('booking screen mapping repository', () => {
  it('chunks the bounded exercise mapping lookup instead of dropping identifiers after 100', async () => {
    const exercisePages: string[][] = [];
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes("mapping.entity_type = 'exercise'")) {
        exercisePages.push(values?.[1] as string[]);
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingScreenMappingRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await repository.resolve({
      tenantId: '10000000-0000-4000-8000-000000000001',
      bookingExternalIds: [],
      exerciseAssociationIds: Array.from({ length: 205 }, (_, index) => `exercise-${index}`),
    });

    expect(exercisePages.map((page) => page.length)).toEqual([100, 100, 5]);
  });

  it('reads trusted mappings without creating mappings from relayed identifiers', async () => {
    const statements: string[] = [];
    const query = vi.fn((text: string) => {
      statements.push(text);
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes("entity_type = 'booking'")) {
        return Promise.resolve({
          rows: [
            {
              external_id: 'private-booking-ref',
              internal_id: '30000000-0000-4000-8000-000000000001',
            },
          ],
        });
      }
      if (text.includes("mapping.entity_type = 'exercise'")) {
        return Promise.resolve({
          rows: [
            {
              external_id: 'private-exercise-ref',
              internal_id: '40000000-0000-4000-8000-000000000001',
            },
          ],
        });
      }
      if (text.includes("mapping.entity_type = 'game_station'")) {
        return Promise.resolve({
          rows: [
            {
              external_id: 'private-station-ref',
              internal_id: '50000000-0000-4000-8000-000000000001',
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createBookingScreenMappingRepository(pool as never);

    await expect(
      repository.resolve({
        tenantId: '10000000-0000-4000-8000-000000000001',
        bookingExternalIds: ['private-booking-ref', 'private-booking-ref'],
        exerciseAssociationIds: ['private-exercise-ref'],
        stationExternalIds: ['private-station-ref'],
      }),
    ).resolves.toEqual({
      bookings: [
        {
          externalId: 'private-booking-ref',
          bookingId: '30000000-0000-4000-8000-000000000001',
        },
      ],
      games: [
        {
          associationId: 'private-exercise-ref',
          gameId: '40000000-0000-4000-8000-000000000001',
        },
      ],
      stations: [
        {
          externalId: 'private-station-ref',
          stationId: '50000000-0000-4000-8000-000000000001',
        },
      ],
    });
    expect(statements.join('\n')).not.toMatch(/insert|update|delete/i);
  });
});
