import { createHash } from 'node:crypto';

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

  it('proves booking ownership from a fresh worker-owned user snapshot', async () => {
    let ownershipSql = '';
    let ownershipValues: readonly unknown[] | undefined;
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('integration.viva_home_booking_ownership')) {
        ownershipSql = text;
        ownershipValues = values;
        return Promise.resolve({
          rows: [
            {
              booking_external_id: 'owned-booking-ref',
              exercise_external_id: 'owned-exercise-ref',
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingScreenMappingRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(
      repository.resolveOwnedBookingExercises?.({
        tenantId: '10000000-0000-4000-8000-000000000001',
        userId: '20000000-0000-4000-8000-000000000001',
        candidates: [
          {
            bookingExternalId: 'owned-booking-ref',
            exerciseExternalId: 'owned-exercise-ref',
            exerciseAssociationIds: ['owned-exercise-ref', 'owned-exercise-association'],
          },
          {
            bookingExternalId: 'owned-booking-ref',
            exerciseExternalId: 'forged-exercise-ref',
            exerciseAssociationIds: ['forged-exercise-ref'],
          },
        ],
        maxAgeSeconds: 300,
      }),
    ).resolves.toEqual(new Map([['owned-booking-ref', new Set(['owned-exercise-ref'])]]));
    expect(ownershipSql).toContain('ownership.user_id = $2');
    expect(ownershipSql).toContain('ownership.booking_external_id = candidate.booking_external_id');
    expect(ownershipSql).toContain(
      'ownership.exercise_external_id = candidate.exercise_external_id',
    );
    expect(ownershipSql).toContain('ownership.fetched_at >= now() - make_interval');
    expect(ownershipSql).not.toContain('jsonb_array_elements');
    expect(ownershipValues).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      ['owned-booking-ref', 'owned-booking-ref'],
      ['owned-exercise-ref', 'forged-exercise-ref'],
      300,
    ]);
  });

  it('resolves Viva client identities to active PadlHub profile UUIDs inside integration storage', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes("mapping.entity_type = 'viva_profile'")) {
        return Promise.resolve({
          rows: [
            {
              external_id: 'private-viva-client-id',
              internal_id: '60000000-0000-4000-8000-000000000001',
            },
          ],
        });
      }
      if (text.includes("mapping.entity_type = 'game_player'")) {
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingScreenMappingRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    const mappings = await repository.resolveVivaProfileIds?.({
      tenantId: '10000000-0000-4000-8000-000000000001',
      externalClientIds: ['private-viva-client-id'],
    });

    expect(mappings).toEqual(
      new Map([['private-viva-client-id', '60000000-0000-4000-8000-000000000001']]),
    );
  });

  it('resolves an existing legacy game-player identity without exposing its provider id', async () => {
    const externalClientId = '33333333-3333-4333-8333-333333333333';
    const associationId = createHash('sha256')
      .update(`phub-local-public-clone-v1:player:${externalClientId}`)
      .digest('hex');
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes("mapping.entity_type = 'viva_profile'")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("mapping.entity_type = 'game_player'")) {
        return Promise.resolve({
          rows: [
            {
              external_id: associationId,
              internal_id: '70000000-0000-4000-8000-000000000001',
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingScreenMappingRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    const mappings = await repository.resolveVivaProfileIds?.({
      tenantId: '10000000-0000-4000-8000-000000000001',
      externalClientIds: [externalClientId],
    });

    expect(mappings).toEqual(new Map([[externalClientId, '70000000-0000-4000-8000-000000000001']]));
  });

  it('returns only unique exact profile-name matches for a trusted roster', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('group by summary.display_name')) {
        return Promise.resolve({
          rows: [
            {
              display_name: 'Анна tg @any_annsm',
              user_ids: ['88479398-814d-46dc-976f-9956831ead5d'],
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingScreenMappingRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    const mappings = await repository.resolveUniqueProfileIdsByDisplayNames?.({
      tenantId: '10000000-0000-4000-8000-000000000001',
      displayNames: ['Анна tg @any_annsm', 'Анна tg @any_annsm'],
    });

    expect(mappings).toEqual(
      new Map([['Анна tg @any_annsm', '88479398-814d-46dc-976f-9956831ead5d']]),
    );
  });
});
