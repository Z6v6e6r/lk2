import { describe, expect, it } from 'vitest';

import { LegacyGamesPublicAdapter, testing } from './index.js';

describe('legacy games adapter', () => {
  it('maps a selected Mongo document without leaking phones, payment URLs or provider booking IDs', () => {
    const mapped = testing.mapLegacyGame({
      id: 'legacy-game-1',
      status: 'PAID',
      updatedAt: '2026-07-18T07:00:00.000Z',
      organizer: {
        id: 'legacy-player-1',
        name: 'Анна',
        ratingNumeric: 3.8,
        phone: '+79990000001',
      },
      participants: [
        { id: 'legacy-player-1', name: 'Анна', ratingNumeric: 3.8 },
        { id: 'legacy-player-2', name: 'Борис', rating: '4,2', phone: '+79990000002' },
      ],
      settings: {
        isPrivate: false,
        minRating: 3,
        maxRating: 4.6,
        payMode: 'split',
        ratingGame: true,
      },
      metadata: {
        gameFormat: 'doubles',
        gameTitle: 'Рейтинговая игра',
        vivaExerciseId: '11111111-1111-4111-8111-111111111111',
      },
      booking: {
        studioId: 'legacy-station-1',
        studioName: 'Терехово',
        roomId: 'legacy-court-1',
        roomName: 'Корт №4',
        timeFromIso: '2026-07-20T18:00:00+03:00',
        timeToIso: '2026-07-20T20:00:00+03:00',
        vivaExerciseId: '11111111-1111-4111-8111-111111111111',
      },
      payment: { paymentUrl: 'https://bank.invalid/secret' },
    });

    expect(mapped).toMatchObject({
      externalId: 'legacy-game-1',
      title: 'Рейтинговая игра',
      kind: 'RATING',
      visibility: 'PUBLIC',
      capacity: 4,
      paymentMode: 'SPLIT',
      levelFrom: 'C',
      levelTo: 'B',
      vivaExerciseExternalId: '11111111-1111-4111-8111-111111111111',
      participants: [
        { displayName: 'Анна', role: 'ORGANIZER', level: 'C+' },
        { displayName: 'Борис', role: 'PLAYER', level: 'B' },
      ],
    });
    expect(JSON.stringify(mapped)).not.toMatch(/phone|paymentUrl|bookingIds/i);
  });

  it('drops records without stable organizer, station or time identity', () => {
    expect(testing.mapLegacyGame({ id: 'legacy-game-2', status: 'PAID' })).toBeUndefined();
  });

  it('anonymizes an over-broad public response before returning the safe snapshot', async () => {
    const fetchImplementation = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            games: [
              {
                id: 'secret-game-id',
                status: 'PAID',
                organizer: {
                  id: 'secret-player-id',
                  name: 'Настоящее имя',
                  phone: '+79990000001',
                  rating: 'D+',
                },
                participants: [
                  {
                    id: 'secret-player-id',
                    name: 'Настоящее имя',
                    phone: '+79990000001',
                    rating: 'D+',
                  },
                ],
                settings: {
                  isPrivate: false,
                  minRating: 'D',
                  maxRating: 'C',
                  payMode: 'self',
                  ratingGame: true,
                },
                metadata: { gameFormat: 'doubles', gameTitle: 'Личный заголовок' },
                booking: {
                  studioId: 'secret-station-id',
                  studioName: 'Терехово',
                  roomId: 'secret-court-id',
                  roomName: 'Корт 1',
                  timeFromIso: '2026-07-20T18:00:00+03:00',
                  timeToIso: '2026-07-20T20:00:00+03:00',
                },
                payment: { paymentUrl: 'https://bank.invalid/private' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const result = await new LegacyGamesPublicAdapter({
      fetchImplementation,
    }).readAvailable({ limit: 20 });

    expect(result[0]).toMatchObject({
      title: 'Рейтинговая игра 2×2',
      visibility: 'PUBLIC',
      levelFrom: 'D',
      levelTo: 'C',
      participants: [{ displayName: 'Организатор', level: 'D+' }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /secret-|Настоящее имя|Личный заголовок|79990000001|paymentUrl|bank\.invalid/,
    );
  });
});
