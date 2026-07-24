import { describe, expect, it, vi } from 'vitest';

import {
  LegacyGamesPublicAdapter,
  localVivaExerciseAssociationId,
  localVivaProfileAssociationId,
  testing,
} from './index.js';

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
        photo: 'https://562807.selcdn.ru/smstretching/anna-photo',
      },
      participants: [
        { id: 'legacy-player-1', name: 'Анна', ratingNumeric: 3.8 },
        {
          id: 'legacy-player-2',
          name: 'Борис',
          rating: '4,2',
          phone: '+79990000002',
          photo: 'http://untrusted.invalid/boris-photo',
        },
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
        {
          displayName: 'Анна',
          role: 'ORGANIZER',
          level: 'C+',
          levelValue: 3.8,
          avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/anna-photo',
        },
        {
          displayName: 'Борис',
          role: 'PLAYER',
          level: 'B',
          levelValue: 4.2,
          avatarSourceUrl: null,
        },
      ],
    });
    expect(JSON.stringify(mapped)).not.toMatch(/phone|paymentUrl|bookingIds/i);
  });

  it('drops records without stable organizer, station or time identity', () => {
    expect(testing.mapLegacyGame({ id: 'legacy-game-2', status: 'PAID' })).toBeUndefined();
  });

  it('sanitizes an over-broad public response while retaining player names', async () => {
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
                  photo: 'https://562807.selcdn.ru/smstretching/source-photo',
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
      title: 'Личный заголовок',
      visibility: 'PUBLIC',
      levelFrom: 'D',
      levelTo: 'C',
      participants: [{ displayName: 'Настоящее имя', level: 'D+', levelValue: null }],
    });
    expect(result[0]?.participants[0]?.avatarSourceUrl).toBe(
      'https://562807.selcdn.ru/smstretching/source-photo',
    );
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('Настоящее имя');
    expect(serialized).not.toMatch(/secret-|79990000001|paymentUrl|bank\.invalid/);
  });

  it('reads a bounded real public Games window for a read-only staging mirror', async () => {
    const game = (id: string, startsAt: string) => ({
      id,
      status: 'PAID',
      organizer: { id: `${id}-organizer`, name: 'Настоящий игрок', rating: 'C' },
      participants: [{ id: `${id}-organizer`, name: 'Настоящий игрок', rating: 'C' }],
      settings: { isPrivate: false, ratingGame: false },
      metadata: { gameFormat: 'doubles' },
      booking: {
        studioId: 'station',
        studioName: 'Терехово',
        timeFromIso: startsAt,
        timeToIso: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      },
    });
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        Response.json({
          games: [
            game('before-window', '2026-07-23T09:00:00.000Z'),
            game('inside-window', '2026-07-25T09:00:00.000Z'),
            game('after-window', '2026-09-10T09:00:00.000Z'),
          ],
        }),
      ),
    );

    const result = await new LegacyGamesPublicAdapter({ fetchImplementation }).read({
      from: '2026-07-24T00:00:00.000Z',
      to: '2026-09-04T00:00:00.000Z',
      limit: 200,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Открытая игра 2×2',
      visibility: 'PUBLIC',
      participants: [{ displayName: 'Настоящий игрок' }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('inside-window-organizer');
    expect(serialized).not.toContain('"externalId":"station"');
  });

  it('matches a requested Viva exercise in memory and returns only its sanitized local roster', async () => {
    const exerciseId = '11111111-1111-4111-8111-111111111111';
    const otherExerciseId = '22222222-2222-4222-8222-222222222222';
    const game = (id: string, vivaExerciseId: string, name: string) => ({
      id,
      status: 'PAID',
      organizer: { id: `${id}-organizer`, name, rating: 'C', ratingNumeric: 3.44 },
      participants: [{ id: `${id}-organizer`, name, rating: 'C', ratingNumeric: 3.44 }],
      settings: { isPrivate: false, ratingGame: false },
      metadata: { gameFormat: 'doubles', vivaExerciseId },
      booking: {
        studioId: 'station',
        studioName: 'Терехово',
        timeFromIso: '2026-07-21T09:00:00+03:00',
        timeToIso: '2026-07-21T10:00:00+03:00',
        vivaExerciseId,
      },
    });
    const fetchImplementation = vi.fn((url: URL | RequestInfo) => {
      const requestedUrl = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      expect(requestedUrl.pathname).toBe('/lk/games');
      expect(requestedUrl.searchParams.get('public')).toBe('true');
      expect(requestedUrl.searchParams.get('available')).toBe('true');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            games: [
              game('requested-game', exerciseId, 'Настоящее имя'),
              game('other-game', otherExerciseId, 'Другое имя'),
            ],
          }),
          { status: 200 },
        ),
      );
    });

    const result = await new LegacyGamesPublicAdapter({
      fetchImplementation,
    }).readByVivaExerciseIds({ exerciseExternalIds: [exerciseId], limit: 5 });

    expect(result).toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({
      vivaExerciseExternalId: localVivaExerciseAssociationId(exerciseId),
      participants: [
        {
          externalId: localVivaProfileAssociationId('requested-game-organizer'),
          displayName: 'Настоящее имя',
          levelValue: 3.44,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/requested-game|other-game|Другое имя/);
  });

  it('reads the authenticated viewer CUP history and filters it by Viva-proven exercises', async () => {
    const exerciseId = '11111111-1111-4111-8111-111111111111';
    const fetchImplementation = vi.fn((url: URL | RequestInfo) => {
      const requestedUrl = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      expect(requestedUrl.pathname).toBe('/lk/games/by-phone');
      expect(requestedUrl.searchParams.get('phone')).toBe('79990000001');
      expect(requestedUrl.searchParams.get('includePast')).toBe('true');
      expect(requestedUrl.searchParams.get('limit')).toBe('500');
      return Promise.resolve(
        Response.json({
          games: [
            {
              id: 'historical-game',
              status: 'PAID',
              organizer: {
                id: 'viewer-profile',
                name: 'Alexey',
                phone: '+7 (999) 000-00-01',
              },
              participants: [
                {
                  id: 'viewer-profile',
                  name: 'Alexey',
                  phone: '+7 (999) 000-00-01',
                  status: 'PAID',
                },
              ],
              settings: { isPrivate: true, ratingGame: false },
              metadata: { gameFormat: 'doubles', vivaExerciseId: exerciseId },
              booking: {
                studioId: 'station',
                studioName: 'Терехово',
                timeFromIso: '2026-07-20T09:00:00+03:00',
                timeToIso: '2026-07-20T10:00:00+03:00',
                vivaExerciseId: exerciseId,
              },
            },
          ],
        }),
      );
    });

    const result = await new LegacyGamesPublicAdapter({
      fetchImplementation,
    }).readByVivaExerciseIds({
      exerciseExternalIds: [exerciseId],
      limit: 1,
      viewerPhoneE164: '+7 (999) 000-00-01',
    });

    expect(result).toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(result[0]?.viewerParticipantExternalId).toBe(
      localVivaProfileAssociationId('viewer-profile'),
    );
    expect(JSON.stringify(result)).not.toContain('79990000001');
  });

  it('continues through CUP history pages until it finds an older Viva exercise', async () => {
    const exerciseId = '21111111-1111-4111-8111-111111111111';
    const fetchImplementation = vi.fn((url: URL | RequestInfo) => {
      const requestedUrl = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      const offset = requestedUrl.searchParams.get('offset');
      if (offset === '0') {
        return Promise.resolve(Response.json({ games: [], total: 501, hasMore: true }));
      }
      expect(offset).toBe('500');
      return Promise.resolve(
        Response.json({
          games: [
            {
              id: 'older-historical-game',
              status: 'PAID',
              organizer: { id: 'viewer-profile', name: 'Alexey' },
              participants: [{ id: 'viewer-profile', name: 'Alexey', status: 'PAID' }],
              settings: { isPrivate: true, ratingGame: false },
              metadata: { gameFormat: 'doubles', vivaExerciseId: exerciseId },
              booking: {
                studioId: 'station',
                studioName: 'Терехово',
                timeFromIso: '2025-07-20T09:00:00+03:00',
                timeToIso: '2025-07-20T10:00:00+03:00',
                vivaExerciseId: exerciseId,
              },
            },
          ],
          total: 501,
          hasMore: false,
        }),
      );
    });

    const result = await new LegacyGamesPublicAdapter({
      fetchImplementation,
    }).readByVivaExerciseIds({
      exerciseExternalIds: [exerciseId],
      limit: 1,
      viewerPhoneE164: '+7 (999) 000-00-01',
    });

    expect(result).toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
