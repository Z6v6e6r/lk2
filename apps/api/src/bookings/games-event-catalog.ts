import { createHash } from 'node:crypto';

import { GAME_PLAYER_LEVELS, type GamePlayerLevel, type PublicGameCardView } from '@phub/games';
import type { PublicTournamentSummary } from '@phub/legacy-games-adapter';

import type { TrainingEventCatalogItem } from './training-event-catalog.js';

export type GamesCatalogKind = 'GAME' | 'COACH_GAME' | 'TOURNAMENT';

export interface CanonicalTournamentCatalogSummary extends PublicTournamentSummary {
  readonly station: {
    readonly id: string;
    readonly name: string;
    readonly shortAddress: string | null;
  };
}

export type GamesEventCatalogItem =
  | { readonly kind: 'GAME'; readonly game: PublicGameCardView }
  | { readonly kind: 'COACH_GAME'; readonly activity: TrainingEventCatalogItem['activity'] }
  | {
      readonly kind: 'TOURNAMENT';
      readonly tournament: PublicTournamentSummary;
      readonly station: CanonicalTournamentCatalogSummary['station'];
    };

export interface GamesEventCatalogIntegrationMapping {
  readonly sourceKind: 'COACH_GAME' | 'TOURNAMENT';
  readonly sourceId: string;
  readonly gameId: string;
}

export interface GamesEventCatalogQuery {
  readonly surface: 'GAMES';
  readonly localDates: readonly string[];
  readonly kinds: readonly GamesCatalogKind[];
  readonly categoryIds?: readonly string[];
  readonly stationIds?: readonly string[];
  readonly availability: 'EXCLUDE_FULL' | 'INCLUDE_FULL';
  readonly levelFrom?: GamePlayerLevel;
  readonly levelTo?: GamePlayerLevel;
  readonly startsAfterLocal?: string;
  readonly limit: number;
}

export interface GamesEventCatalogMetadata {
  readonly totalMatched: number | null;
  readonly facets: {
    readonly categories: readonly {
      readonly id: string;
      readonly name: string;
      readonly count: number;
    }[];
    readonly stations: readonly {
      readonly id: string;
      readonly name: string;
      readonly count: number;
    }[];
    readonly kinds: readonly { readonly kind: GamesCatalogKind; readonly count: number }[];
  } | null;
  readonly sourceStatus: readonly {
    readonly source: 'LOCAL_GAMES' | 'SCHEDULE' | 'TOURNAMENTS';
    readonly localDate: string | null;
    readonly state: 'READY' | 'UNAVAILABLE';
    readonly errorCode:
      | 'LOCAL_GAMES_READ_INCOMPLETE'
      | 'SCHEDULE_READ_INCOMPLETE'
      | 'TOURNAMENTS_READ_INCOMPLETE'
      | null;
  }[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const GAMES_KINDS: readonly GamesCatalogKind[] = ['GAME', 'COACH_GAME', 'TOURNAMENT'];
const KIND_RANK: Readonly<Record<GamesCatalogKind, number>> = {
  GAME: 0,
  COACH_GAME: 1,
  TOURNAMENT: 2,
};

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function stringArray(
  value: unknown,
  input: { readonly min: number; readonly max: number; readonly pattern?: RegExp },
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < input.min || value.length > input.max)
    return undefined;
  if (
    value.some(
      (item) =>
        typeof item !== 'string' || (input.pattern !== undefined && !input.pattern.test(item)),
    )
  ) {
    return undefined;
  }
  const normalized = uniqueSorted(value as readonly string[]);
  return normalized.length >= input.min ? normalized : undefined;
}

export function normalizeGamesEventCatalogQuery(
  value: unknown,
): GamesEventCatalogQuery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'surface',
          'localDates',
          'kinds',
          'categoryIds',
          'stationIds',
          'availability',
          'levelFrom',
          'levelTo',
          'startsAfterLocal',
          'limit',
        ].includes(key),
    ) ||
    input.surface !== 'GAMES'
  ) {
    return undefined;
  }
  const localDates = stringArray(input.localDates, { min: 1, max: 15, pattern: DATE_PATTERN });
  const kinds = stringArray(input.kinds, { min: 1, max: GAMES_KINDS.length });
  const categoryIds =
    input.categoryIds === undefined ||
    (Array.isArray(input.categoryIds) && input.categoryIds.length === 0)
      ? undefined
      : stringArray(input.categoryIds, { min: 1, max: 50, pattern: UUID_PATTERN });
  const stationIds =
    input.stationIds === undefined ||
    (Array.isArray(input.stationIds) && input.stationIds.length === 0)
      ? undefined
      : stringArray(input.stationIds, { min: 1, max: 50, pattern: UUID_PATTERN });
  const levelFrom = typeof input.levelFrom === 'string' ? input.levelFrom : undefined;
  const levelTo = typeof input.levelTo === 'string' ? input.levelTo : undefined;
  if (
    !localDates ||
    !kinds ||
    kinds.some((kind) => !GAMES_KINDS.includes(kind as GamesCatalogKind)) ||
    (input.categoryIds !== undefined &&
      (!Array.isArray(input.categoryIds) || (input.categoryIds.length > 0 && !categoryIds))) ||
    (input.stationIds !== undefined &&
      (!Array.isArray(input.stationIds) || (input.stationIds.length > 0 && !stationIds))) ||
    !['EXCLUDE_FULL', 'INCLUDE_FULL'].includes(String(input.availability)) ||
    (levelFrom !== undefined && !GAME_PLAYER_LEVELS.includes(levelFrom as GamePlayerLevel)) ||
    (levelTo !== undefined && !GAME_PLAYER_LEVELS.includes(levelTo as GamePlayerLevel)) ||
    (levelFrom !== undefined &&
      levelTo !== undefined &&
      GAME_PLAYER_LEVELS.indexOf(levelFrom as GamePlayerLevel) >
        GAME_PLAYER_LEVELS.indexOf(levelTo as GamePlayerLevel)) ||
    (input.startsAfterLocal !== undefined &&
      (typeof input.startsAfterLocal !== 'string' || !TIME_PATTERN.test(input.startsAfterLocal))) ||
    !Number.isInteger(input.limit) ||
    Number(input.limit) < 1 ||
    Number(input.limit) > 50
  ) {
    return undefined;
  }
  return {
    surface: 'GAMES',
    localDates,
    kinds: kinds as readonly GamesCatalogKind[],
    ...(categoryIds ? { categoryIds } : {}),
    ...(stationIds ? { stationIds } : {}),
    availability: input.availability as GamesEventCatalogQuery['availability'],
    ...(levelFrom ? { levelFrom: levelFrom as GamePlayerLevel } : {}),
    ...(levelTo ? { levelTo: levelTo as GamePlayerLevel } : {}),
    ...(typeof input.startsAfterLocal === 'string'
      ? { startsAfterLocal: input.startsAfterLocal }
      : {}),
    limit: Number(input.limit),
  };
}

export function gamesEventCatalogQueryHash(query: GamesEventCatalogQuery): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex');
}

function itemId(item: GamesEventCatalogItem): string {
  if (item.kind === 'GAME') return item.game.id;
  if (item.kind === 'COACH_GAME') return item.activity.id;
  return item.tournament.id;
}

function itemStartsAt(item: GamesEventCatalogItem): string {
  if (item.kind === 'GAME') return item.game.startsAt;
  if (item.kind === 'COACH_GAME') return item.activity.startsAt;
  return item.tournament.startsAt;
}

function itemStation(item: GamesEventCatalogItem): { readonly id: string; readonly name: string } {
  if (item.kind === 'GAME') return item.game.station;
  if (item.kind === 'COACH_GAME') return item.activity.station;
  return item.station;
}

function itemCategory(
  item: GamesEventCatalogItem,
): { readonly id: string; readonly name: string } | undefined {
  return item.kind === 'COACH_GAME' ? (item.activity.category ?? undefined) : undefined;
}

function itemOpen(item: GamesEventCatalogItem): number | null {
  if (item.kind === 'GAME') return item.game.capacity.open;
  if (item.kind === 'COACH_GAME') return item.activity.capacity.open;
  return item.tournament.capacity.open;
}

function itemLevelRange(item: GamesEventCatalogItem): {
  readonly from: string | null;
  readonly to: string | null;
} | null {
  if (item.kind === 'GAME') return item.game.levelRange;
  if (item.kind === 'COACH_GAME') return item.activity.levelRange;
  return item.tournament.levelRange;
}

function localDateAndMinutes(
  startsAt: string,
  timezone: string,
): {
  readonly date: string;
  readonly minutes: number;
} {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(startsAt))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function matchesLevel(item: GamesEventCatalogItem, query: GamesEventCatalogQuery): boolean {
  if (!query.levelFrom && !query.levelTo) return true;
  const range = itemLevelRange(item);
  if (!range?.from || !range.to) return false;
  const requestedFrom = query.levelFrom ? GAME_PLAYER_LEVELS.indexOf(query.levelFrom) : 0;
  const requestedTo = query.levelTo
    ? GAME_PLAYER_LEVELS.indexOf(query.levelTo)
    : GAME_PLAYER_LEVELS.length - 1;
  const itemFrom = GAME_PLAYER_LEVELS.indexOf(range.from as GamePlayerLevel);
  const itemTo = GAME_PLAYER_LEVELS.indexOf(range.to as GamePlayerLevel);
  return itemFrom >= 0 && itemTo >= 0 && itemTo >= requestedFrom && itemFrom <= requestedTo;
}

function sourceStatuses(input: {
  readonly query: GamesEventCatalogQuery;
  readonly localGamesComplete: boolean;
  readonly completedScheduleDates: ReadonlySet<string>;
  readonly tournamentsComplete: boolean;
}): GamesEventCatalogMetadata['sourceStatus'] {
  const kinds = new Set(input.query.kinds);
  return [
    ...(kinds.has('GAME')
      ? [
          {
            source: 'LOCAL_GAMES' as const,
            localDate: null,
            state: input.localGamesComplete ? ('READY' as const) : ('UNAVAILABLE' as const),
            errorCode: input.localGamesComplete ? null : ('LOCAL_GAMES_READ_INCOMPLETE' as const),
          },
        ]
      : []),
    ...(kinds.has('COACH_GAME')
      ? input.query.localDates.map((localDate) => ({
          source: 'SCHEDULE' as const,
          localDate,
          state: input.completedScheduleDates.has(localDate)
            ? ('READY' as const)
            : ('UNAVAILABLE' as const),
          errorCode: input.completedScheduleDates.has(localDate)
            ? null
            : ('SCHEDULE_READ_INCOMPLETE' as const),
        }))
      : []),
    ...(kinds.has('TOURNAMENT')
      ? [
          {
            source: 'TOURNAMENTS' as const,
            localDate: null,
            state: input.tournamentsComplete ? ('READY' as const) : ('UNAVAILABLE' as const),
            errorCode: input.tournamentsComplete ? null : ('TOURNAMENTS_READ_INCOMPLETE' as const),
          },
        ]
      : []),
  ];
}

export function buildGamesEventCatalog(input: {
  readonly games: readonly PublicGameCardView[];
  readonly coachGames: readonly TrainingEventCatalogItem[];
  readonly tournaments: readonly CanonicalTournamentCatalogSummary[];
  readonly integrationMappings?: readonly GamesEventCatalogIntegrationMapping[];
  readonly query: GamesEventCatalogQuery;
  readonly localGamesComplete: boolean;
  readonly completedScheduleDates: readonly string[];
  readonly tournamentsComplete: boolean;
  readonly timezone: string;
}): {
  readonly state: 'READY' | 'PARTIAL';
  readonly items: readonly GamesEventCatalogItem[];
  readonly metadata: GamesEventCatalogMetadata;
} {
  const games = new Map(input.games.map((game) => [game.id, game] as const));
  const mappedSourceItems = new Set(
    (input.integrationMappings ?? []).flatMap((mapping) =>
      games.has(mapping.gameId) ? [`${mapping.sourceKind}:${mapping.sourceId}`] : [],
    ),
  );
  const coachGames = new Map<
    string,
    { readonly kind: 'COACH_GAME'; readonly activity: TrainingEventCatalogItem['activity'] }
  >(
    input.coachGames.flatMap((item) =>
      item.kind === 'COACH_GAME' && !mappedSourceItems.has(`COACH_GAME:${item.activity.id}`)
        ? [[item.activity.id, { kind: 'COACH_GAME', activity: item.activity }] as const]
        : [],
    ),
  );
  const tournaments = new Map(
    input.tournaments.flatMap((tournament) =>
      !mappedSourceItems.has(`TOURNAMENT:${tournament.id}`)
        ? [[tournament.id, tournament] as const]
        : [],
    ),
  );
  const allItems: GamesEventCatalogItem[] = [
    ...[...games.values()].map((game) => ({ kind: 'GAME' as const, game })),
    ...coachGames.values(),
    ...[...tournaments.values()].map(({ station, ...tournament }) => ({
      kind: 'TOURNAMENT' as const,
      tournament,
      station,
    })),
  ];
  const requestedDates = new Set(input.query.localDates);
  const kinds = new Set(input.query.kinds);
  const categoryIds = new Set(input.query.categoryIds ?? []);
  const stationIds = new Set(input.query.stationIds ?? []);
  const startsAfter = input.query.startsAfterLocal
    ? Number(input.query.startsAfterLocal.slice(0, 2)) * 60 +
      Number(input.query.startsAfterLocal.slice(3))
    : undefined;
  const baseItems = allItems.filter((item) => {
    const local = localDateAndMinutes(itemStartsAt(item), input.timezone);
    return (
      requestedDates.has(local.date) &&
      (input.query.availability === 'INCLUDE_FULL' || itemOpen(item) !== 0) &&
      matchesLevel(item, input.query) &&
      (startsAfter === undefined || local.minutes >= startsAfter)
    );
  });
  const matchesKind = (item: GamesEventCatalogItem): boolean => kinds.has(item.kind);
  const matchesCategory = (item: GamesEventCatalogItem): boolean => {
    if (categoryIds.size === 0) return true;
    const category = itemCategory(item);
    return category !== undefined && categoryIds.has(category.id);
  };
  const matchesStation = (item: GamesEventCatalogItem): boolean =>
    stationIds.size === 0 || stationIds.has(itemStation(item).id);
  const items = baseItems
    .filter((item) => matchesKind(item) && matchesCategory(item) && matchesStation(item))
    .sort(
      (left, right) =>
        itemStartsAt(left).localeCompare(itemStartsAt(right)) ||
        KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
        itemId(left).localeCompare(itemId(right)),
    );
  const sourceStatus = sourceStatuses({
    query: input.query,
    localGamesComplete: input.localGamesComplete,
    completedScheduleDates: new Set(input.completedScheduleDates),
    tournamentsComplete: input.tournamentsComplete,
  });
  const state = sourceStatus.every((source) => source.state === 'READY') ? 'READY' : 'PARTIAL';
  const counts = <T extends { readonly id: string; readonly name: string }>(values: readonly T[]) =>
    [...new Map(values.map((value) => [value.id, value])).values()]
      .map((value) => ({
        id: value.id,
        name: value.name,
        count: values.filter((candidate) => candidate.id === value.id).length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU'));
  return {
    state,
    items,
    metadata: {
      totalMatched: state === 'READY' ? items.length : null,
      facets:
        state === 'READY'
          ? {
              categories: counts(
                baseItems
                  .filter((item) => matchesKind(item) && matchesStation(item))
                  .flatMap((item) => {
                    const category = itemCategory(item);
                    return category ? [category] : [];
                  }),
              ),
              stations: counts(
                baseItems
                  .filter((item) => matchesKind(item) && matchesCategory(item))
                  .map(itemStation),
              ),
              kinds: GAMES_KINDS.flatMap((kind) => {
                const count = baseItems.filter(
                  (item) => item.kind === kind && matchesCategory(item) && matchesStation(item),
                ).length;
                return count > 0 ? [{ kind, count }] : [];
              }),
            }
          : null,
      sourceStatus,
    },
  };
}
