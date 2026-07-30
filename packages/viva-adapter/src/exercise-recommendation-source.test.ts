import { describe, expect, it, vi } from 'vitest';

import { VivaExerciseRecommendationSourceAdapter } from './exercise-recommendation-source.js';

describe('Viva exercise recommendation source', () => {
  it('normalizes trainings and tournaments without exposing Viva identifiers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([
        {
          id: 'training-viva-42',
          type: { id: 605, name: 'Групповая тренировка' },
          direction: { id: 100, name: 'Тренировки' },
          timeFrom: '2026-07-27T15:00:00.000+03:00',
          timeTo: '2026-07-27T16:30:00.000+03:00',
          studio: { id: 10, name: 'Терехово', address: 'ул. Тестовая, 1' },
          maxClientsCount: 8,
          clientsCount: 5,
          accessLevels: [2.5, 3],
          trainers: [
            {
              id: 'trainer-viva-12',
              firstName: 'Мария',
              lastName: 'Орлова',
              photo: 'https://provider.invalid/trainer.jpg',
            },
          ],
        },
        {
          id: 'tournament-viva-77',
          type: { id: 839, name: 'Мини-турнир' },
          direction: { id: 5278, name: 'Время на друзей' },
          timeFrom: '2026-07-28T16:00:00.000+03:00',
          timeTo: '2026-07-28T18:00:00.000+03:00',
          studio: { id: 11, name: 'Сколково' },
          maxClientsCount: 16,
          availablePlaces: 1,
          organizer: {
            id: 'organizer-viva-15',
            displayName: 'Илья Соколов',
            photo: 'https://provider.invalid/organizer.jpg',
          },
        },
      ]),
    );
    const source = new VivaExerciseRecommendationSourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api/',
      providerTenantKey: 'tenant',
      timeoutMs: 1_000,
      fetchImplementation,
    });

    const items = await source.readDate({
      date: '2026-07-27',
      accessToken: 'user-token',
      correlationId: 'correlation-test-0001',
    });

    expect(items).toMatchObject([
      {
        kind: 'TRAINING',
        title: 'Групповая тренировка',
        station: { name: 'Терехово' },
        levelRange: { from: 'D+', to: 'C' },
        capacity: { total: 8, open: 3 },
        host: {
          displayName: 'Мария Орлова',
          avatarUrl: null,
          role: 'TRAINER',
        },
      },
      {
        kind: 'TOURNAMENT',
        title: 'Мини-турнир',
        station: { name: 'Сколково' },
        capacity: { total: 16, open: 1 },
        host: {
          displayName: 'Илья Соколов',
          avatarUrl: null,
          role: 'ORGANIZER',
        },
      },
    ]);
    expect(JSON.stringify(items)).not.toMatch(
      /training-viva-42|tournament-viva-77|trainer-viva-12|organizer-viva-15|provider\.invalid/,
    );
    expect(source.readAvatarSource(items[0]?.id ?? '')).toBe(
      'https://provider.invalid/trainer.jpg',
    );
    expect(source.readAvatarSource(items[1]?.id ?? '')).toBe(
      'https://provider.invalid/organizer.jpg',
    );
    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
      authorization: 'Bearer user-token',
      'x-correlation-id': 'correlation-test-0001',
    });
  });

  it('retries bounded transient failures and opens the circuit after repeated final failures', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const source = new VivaExerciseRecommendationSourceAdapter({
      mode: 'production',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api/',
      providerTenantKey: 'tenant',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 1,
      fetchImplementation,
      sleep: () => Promise.resolve(),
    });
    const input = {
      date: '2026-07-27',
      accessToken: 'user-token',
      correlationId: 'correlation-test-0002',
    };

    await expect(source.readDate(input)).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    await expect(source.readDate(input)).rejects.toThrow(
      'VIVA_EXERCISE_RECOMMENDATION_CIRCUIT_OPEN',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
