import type { PublicGameCardView } from '@phub/games';
import type { VivaExerciseRecommendation } from '@phub/viva-adapter';
import { describe, expect, it } from 'vitest';

import {
  buildGamesEventCatalog,
  gamesEventCatalogQueryHash,
  normalizeGamesEventCatalogQuery,
  type CanonicalTournamentCatalogSummary,
  type GamesEventCatalogQuery,
} from './games-event-catalog.js';

const stationOne = '11111111-1111-4111-8111-111111111111';
const stationTwo = '22222222-2222-4222-8222-222222222222';
const coachCategory = '33333333-3333-4333-8333-333333333333';

function game(id: string, input: Partial<PublicGameCardView> = {}): PublicGameCardView {
  return {
    id,
    revision: 1,
    surface: 'DISCOVER',
    displayState: 'FINDING_PLAYERS',
    title: 'Открытая игра',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    startsAt: '2026-08-02T07:00:00.000Z',
    endsAt: '2026-08-02T08:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: { id: stationOne, name: 'Станция 1', shortAddress: null },
    court: null,
    levelRange: { from: 'D', to: 'C+' },
    rosterState: 'OPEN',
    capacity: { total: 4, occupied: 1, reserved: 0, open: 3, waitlistCount: 0 },
    participants: [],
    priceSummary: null,
    viewerRelation: 'ANONYMOUS',
    viewerPaymentState: 'NOT_REQUIRED',
    badges: [],
    allowedActions: ['JOIN'],
    deepLink: `/games/${id}`,
    ...input,
  };
}

function coachActivity(
  id: string,
  input: Partial<VivaExerciseRecommendation> = {},
): VivaExerciseRecommendation {
  return {
    id,
    kind: 'TRAINING',
    title: 'Игра+Тренер. Уровень D+',
    startsAt: '2026-08-02T07:00:00.000Z',
    endsAt: '2026-08-02T08:00:00.000Z',
    timezone: 'Europe/Moscow',
    station: { id: stationOne, name: 'Станция 1', shortAddress: null },
    category: { id: coachCategory, name: 'Игра+Тренер. Уровень D+' },
    levelRange: { from: 'D+', to: 'D+' },
    capacity: { total: 3, open: 2 },
    host: { displayName: 'Тренер', avatarUrl: null, role: 'TRAINER' },
    route: `/trainings?event=${id}`,
    ...input,
  };
}

function tournament(
  id: string,
  input: Partial<CanonicalTournamentCatalogSummary> = {},
): CanonicalTournamentCatalogSummary {
  return {
    id,
    title: 'Американо',
    format: 'AMERICANO',
    startsAt: '2026-08-02T07:00:00.000Z',
    endsAt: '2026-08-02T09:00:00.000Z',
    venue: 'Станция 1',
    station: { id: stationOne, name: 'Станция 1', shortAddress: null },
    trainerName: null,
    levelRange: { from: 'D', to: 'C+' },
    organizer: null,
    capacity: { total: 12, registered: 8, open: 4, waitlist: 0 },
    status: 'REGISTRATION',
    route: `/tournaments?event=${id}`,
    ...input,
  };
}

function query(input: Partial<GamesEventCatalogQuery> = {}): GamesEventCatalogQuery {
  return {
    surface: 'GAMES',
    localDates: ['2026-08-02'],
    kinds: ['GAME', 'COACH_GAME', 'TOURNAMENT'],
    availability: 'EXCLUDE_FULL',
    limit: 20,
    ...input,
  };
}

function build(
  input: Partial<Parameters<typeof buildGamesEventCatalog>[0]> = {},
): ReturnType<typeof buildGamesEventCatalog> {
  return buildGamesEventCatalog({
    games: [],
    coachGames: [],
    tournaments: [],
    query: query(),
    localGamesComplete: true,
    completedScheduleDates: ['2026-08-02'],
    tournamentsComplete: true,
    timezone: 'Europe/Moscow',
    ...input,
  });
}

describe('games event catalog', () => {
  it('rejects training-only kinds on the GAMES surface', () => {
    expect(
      normalizeGamesEventCatalogQuery({
        surface: 'GAMES',
        localDates: ['2026-08-02'],
        kinds: ['GROUP_TRAINING'],
        availability: 'EXCLUDE_FULL',
        limit: 20,
      }),
    ).toBeUndefined();
  });

  it('normalizes unordered filters before hashing', () => {
    const first = normalizeGamesEventCatalogQuery({
      surface: 'GAMES',
      localDates: ['2026-08-03', '2026-08-02', '2026-08-02'],
      kinds: ['TOURNAMENT', 'GAME', 'GAME'],
      categoryIds: [],
      stationIds: [stationTwo, stationOne, stationOne],
      availability: 'EXCLUDE_FULL',
      limit: 20,
    });
    const second = normalizeGamesEventCatalogQuery({
      surface: 'GAMES',
      localDates: ['2026-08-02', '2026-08-03'],
      kinds: ['GAME', 'TOURNAMENT'],
      stationIds: [stationOne, stationTwo],
      availability: 'EXCLUDE_FULL',
      limit: 20,
    });
    expect(first).toEqual(second);
    expect(gamesEventCatalogQueryHash(first!)).toBe(gamesEventCatalogQueryHash(second!));
  });

  it('filters the complete set before the page limit', () => {
    const fullGames = Array.from({ length: 20 }, (_, index) =>
      game(`full-${index}`, {
        capacity: { total: 4, occupied: 4, reserved: 0, open: 0, waitlistCount: 0 },
      }),
    );
    const match = tournament('match');
    const result = build({ games: fullGames, tournaments: [match] });

    expect(result.items.map((item) => item.kind)).toEqual(['TOURNAMENT']);
    expect(result.metadata.totalMatched).toBe(1);

    const moreThanOnePage = build({
      games: Array.from({ length: 21 }, (_, index) => game(`match-${index}`)),
      query: query({ kinds: ['GAME'], limit: 20 }),
    });
    expect(moreThanOnePage.items).toHaveLength(21);
    expect(moreThanOnePage.metadata.totalMatched).toBe(21);
  });

  it('uses explicit kind rank and PadlHub id for equal start times', () => {
    const result = build({
      games: [game('game-b'), game('game-a')],
      coachGames: [
        { kind: 'COACH_GAME', activity: coachActivity('coach-b') },
        { kind: 'COACH_GAME', activity: coachActivity('coach-a') },
      ],
      tournaments: [tournament('tournament-b'), tournament('tournament-a')],
    });

    expect(
      result.items.map((item) =>
        item.kind === 'GAME'
          ? `${item.kind}:${item.game.id}`
          : item.kind === 'COACH_GAME'
            ? `${item.kind}:${item.activity.id}`
            : `${item.kind}:${item.tournament.id}`,
      ),
    ).toEqual([
      'GAME:game-a',
      'GAME:game-b',
      'COACH_GAME:coach-a',
      'COACH_GAME:coach-b',
      'TOURNAMENT:tournament-a',
      'TOURNAMENT:tournament-b',
    ]);
  });

  it('deduplicates cross-source rows only through an explicit integration mapping', () => {
    const local = game('canonical-game', { title: 'Одинаковое событие' });
    const mappedCoach = coachActivity('mapped-coach', { title: 'Одинаковое событие' });
    const unmappedCoach = coachActivity('unmapped-coach', { title: 'Одинаковое событие' });
    const mappedTournament = tournament('mapped-tournament', { title: 'Одинаковое событие' });
    const unmappedTournament = tournament('unmapped-tournament', { title: 'Одинаковое событие' });
    const orphanMappingCoach = coachActivity('orphan-mapping', { title: 'Одинаковое событие' });
    const result = build({
      games: [local],
      coachGames: [
        { kind: 'COACH_GAME', activity: mappedCoach },
        { kind: 'COACH_GAME', activity: unmappedCoach },
        { kind: 'COACH_GAME', activity: orphanMappingCoach },
      ],
      tournaments: [mappedTournament, unmappedTournament],
      integrationMappings: [
        { sourceKind: 'COACH_GAME', sourceId: mappedCoach.id, gameId: local.id },
        { sourceKind: 'TOURNAMENT', sourceId: mappedTournament.id, gameId: local.id },
        { sourceKind: 'COACH_GAME', sourceId: orphanMappingCoach.id, gameId: 'missing-game' },
      ],
    });

    expect(
      result.items.map((item) =>
        item.kind === 'GAME'
          ? item.game.id
          : item.kind === 'COACH_GAME'
            ? item.activity.id
            : item.tournament.id,
      ),
    ).toEqual(['canonical-game', 'orphan-mapping', 'unmapped-coach', 'unmapped-tournament']);
  });

  it('applies date, OR station, category, availability, level and local-time filters', () => {
    const selectedCoach = coachActivity('selected', {
      station: { id: stationTwo, name: 'Станция 2', shortAddress: null },
      startsAt: '2026-08-02T15:30:00.000Z',
    });
    const noLevel = coachActivity('no-level', { levelRange: null });
    const full = coachActivity('full', { capacity: { total: 3, open: 0 } });
    const result = build({
      games: [game('game-without-category')],
      coachGames: [
        { kind: 'COACH_GAME', activity: selectedCoach },
        { kind: 'COACH_GAME', activity: noLevel },
        { kind: 'COACH_GAME', activity: full },
      ],
      tournaments: [tournament('tournament-without-category')],
      query: query({
        categoryIds: [coachCategory],
        stationIds: [stationOne, stationTwo],
        levelFrom: 'D',
        levelTo: 'D+',
        startsAfterLocal: '18:00',
      }),
    });

    expect(result.items).toEqual([{ kind: 'COACH_GAME', activity: selectedCoach }]);
    expect(result.metadata.facets?.stations).toEqual([
      { id: stationTwo, name: 'Станция 2', count: 1 },
    ]);
  });

  it('filters tournaments by canonical station UUID instead of venue text', () => {
    const canonicalStationTwo = tournament('canonical-station-two', {
      venue: 'Станция 1',
      station: { id: stationTwo, name: 'Станция 2', shortAddress: null },
    });
    const result = build({
      tournaments: [canonicalStationTwo],
      query: query({ kinds: ['TOURNAMENT'], stationIds: [stationTwo] }),
      completedScheduleDates: [],
    });

    const { station, ...summary } = canonicalStationTwo;
    expect(result.items).toEqual([{ kind: 'TOURNAMENT', tournament: summary, station }]);
  });

  it('returns exact facets only when every selected source is ready', () => {
    const partial = build({
      games: [game('game')],
      coachGames: [{ kind: 'COACH_GAME', activity: coachActivity('coach') }],
      tournaments: [tournament('tournament')],
      localGamesComplete: false,
      completedScheduleDates: [],
      tournamentsComplete: false,
    });
    expect(partial.state).toBe('PARTIAL');
    expect(partial.metadata.totalMatched).toBeNull();
    expect(partial.metadata.facets).toBeNull();
    expect(partial.metadata.sourceStatus).toEqual([
      {
        source: 'LOCAL_GAMES',
        localDate: null,
        state: 'UNAVAILABLE',
        errorCode: 'LOCAL_GAMES_READ_INCOMPLETE',
      },
      {
        source: 'SCHEDULE',
        localDate: '2026-08-02',
        state: 'UNAVAILABLE',
        errorCode: 'SCHEDULE_READ_INCOMPLETE',
      },
      {
        source: 'TOURNAMENTS',
        localDate: null,
        state: 'UNAVAILABLE',
        errorCode: 'TOURNAMENTS_READ_INCOMPLETE',
      },
    ]);

    const ready = build({
      games: [game('game')],
      coachGames: [{ kind: 'COACH_GAME', activity: coachActivity('coach') }],
      tournaments: [tournament('tournament')],
    });
    expect(ready.state).toBe('READY');
    expect(ready.metadata.totalMatched).toBe(3);
    expect(ready.metadata.facets?.kinds).toEqual([
      { kind: 'GAME', count: 1 },
      { kind: 'COACH_GAME', count: 1 },
      { kind: 'TOURNAMENT', count: 1 },
    ]);
    expect(ready.metadata.facets?.stations).toEqual([
      { id: stationOne, name: 'Станция 1', count: 3 },
    ]);
  });

  it('does not require an unselected source to be ready', () => {
    const result = build({
      games: [game('game')],
      query: query({ kinds: ['GAME'] }),
      completedScheduleDates: [],
      tournamentsComplete: false,
    });
    expect(result.state).toBe('READY');
    expect(result.metadata.sourceStatus).toEqual([
      { source: 'LOCAL_GAMES', localDate: null, state: 'READY', errorCode: null },
    ]);
  });
});
