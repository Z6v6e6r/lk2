import { createHash } from 'node:crypto';

import { GAME_PLAYER_LEVELS, type GamePlayerLevel } from '@phub/games';
import {
  isGroupTrainingCatalogActivity,
  type VivaExerciseRecommendation,
} from '@phub/viva-adapter';

export type TrainingCatalogKind = 'COACH_GAME' | 'GROUP_TRAINING' | 'SPLIT';

export interface TrainingEventCatalogItem {
  readonly kind: TrainingCatalogKind;
  readonly activity: VivaExerciseRecommendation;
}

export interface TrainingEventCatalogQuery {
  readonly surface: 'TRAININGS';
  readonly localDates: readonly string[];
  readonly kinds: readonly TrainingCatalogKind[];
  readonly categoryIds?: readonly string[];
  readonly stationIds?: readonly string[];
  readonly availability: 'EXCLUDE_FULL' | 'INCLUDE_FULL';
  readonly levelFrom?: (typeof GAME_PLAYER_LEVELS)[number];
  readonly levelTo?: (typeof GAME_PLAYER_LEVELS)[number];
  readonly startsAfterLocal?: string;
  readonly limit: number;
}

export interface TrainingEventCatalogMetadata {
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
    readonly kinds: readonly { readonly kind: TrainingCatalogKind; readonly count: number }[];
  } | null;
  readonly sourceStatus: readonly {
    readonly source: 'SCHEDULE';
    readonly localDate: string;
    readonly state: 'READY' | 'UNAVAILABLE';
    readonly errorCode: 'SCHEDULE_READ_INCOMPLETE' | null;
  }[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TRAINING_KINDS: readonly TrainingCatalogKind[] = ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'];
const TRAINING_KIND_RANK: Readonly<Record<TrainingCatalogKind, number>> = {
  COACH_GAME: 0,
  GROUP_TRAINING: 1,
  SPLIT: 2,
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
  const values = value.filter((item): item is string => typeof item === 'string');
  if (
    values.length !== value.length ||
    values.some((item) => input.pattern && !input.pattern.test(item))
  ) {
    return undefined;
  }
  const normalized = uniqueSorted(values);
  return normalized.length >= input.min ? normalized : undefined;
}

export function normalizeTrainingEventCatalogQuery(
  value: unknown,
): TrainingEventCatalogQuery | undefined {
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
    input.surface !== 'TRAININGS'
  ) {
    return undefined;
  }
  const localDates = stringArray(input.localDates, { min: 1, max: 15, pattern: DATE_PATTERN });
  const kinds = stringArray(input.kinds, { min: 1, max: TRAINING_KINDS.length });
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
    kinds.some((kind) => !TRAINING_KINDS.includes(kind as TrainingCatalogKind)) ||
    (input.categoryIds !== undefined &&
      (!Array.isArray(input.categoryIds) || (input.categoryIds.length > 0 && !categoryIds))) ||
    (input.stationIds !== undefined &&
      (!Array.isArray(input.stationIds) || (input.stationIds.length > 0 && !stationIds))) ||
    !['EXCLUDE_FULL', 'INCLUDE_FULL'].includes(String(input.availability)) ||
    (levelFrom !== undefined && !GAME_PLAYER_LEVELS.includes(levelFrom as never)) ||
    (levelTo !== undefined && !GAME_PLAYER_LEVELS.includes(levelTo as never)) ||
    (levelFrom &&
      levelTo &&
      GAME_PLAYER_LEVELS.indexOf(levelFrom as never) >
        GAME_PLAYER_LEVELS.indexOf(levelTo as never)) ||
    (input.startsAfterLocal !== undefined &&
      (typeof input.startsAfterLocal !== 'string' || !TIME_PATTERN.test(input.startsAfterLocal))) ||
    !Number.isInteger(input.limit) ||
    Number(input.limit) < 1 ||
    Number(input.limit) > 50
  ) {
    return undefined;
  }
  return {
    surface: 'TRAININGS',
    localDates,
    kinds: kinds as readonly TrainingCatalogKind[],
    ...(categoryIds ? { categoryIds } : {}),
    ...(stationIds ? { stationIds } : {}),
    availability: input.availability as TrainingEventCatalogQuery['availability'],
    ...(levelFrom ? { levelFrom: levelFrom as GamePlayerLevel } : {}),
    ...(levelTo ? { levelTo: levelTo as GamePlayerLevel } : {}),
    ...(typeof input.startsAfterLocal === 'string'
      ? { startsAfterLocal: input.startsAfterLocal }
      : {}),
    limit: Number(input.limit),
  };
}

export function trainingEventCatalogQueryHash(query: TrainingEventCatalogQuery): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex');
}

export function trainingCatalogKind(activity: VivaExerciseRecommendation): TrainingCatalogKind {
  const name = `${activity.category?.name ?? ''} ${activity.title}`.toLocaleLowerCase('ru-RU');
  if (/игра\s*\+\s*тренер/u.test(name)) return 'COACH_GAME';
  if (/\bсплит\b/u.test(name)) return 'SPLIT';
  return 'GROUP_TRAINING';
}

function localDateAndMinutes(
  activity: VivaExerciseRecommendation,
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
      .formatToParts(new Date(activity.startsAt))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function matchesLevel(
  activity: VivaExerciseRecommendation,
  query: TrainingEventCatalogQuery,
): boolean {
  if (!query.levelFrom && !query.levelTo) return true;
  if (!activity.levelRange?.from || !activity.levelRange.to) return false;
  const requestedFrom = query.levelFrom ? GAME_PLAYER_LEVELS.indexOf(query.levelFrom) : 0;
  const requestedTo = query.levelTo
    ? GAME_PLAYER_LEVELS.indexOf(query.levelTo)
    : GAME_PLAYER_LEVELS.length - 1;
  const activityFrom = GAME_PLAYER_LEVELS.indexOf(activity.levelRange.from as GamePlayerLevel);
  const activityTo = GAME_PLAYER_LEVELS.indexOf(activity.levelRange.to as GamePlayerLevel);
  return activityTo >= requestedFrom && activityFrom <= requestedTo;
}

export function buildTrainingEventCatalog(input: {
  readonly activities: readonly VivaExerciseRecommendation[];
  readonly query: TrainingEventCatalogQuery;
  readonly completedDates: readonly string[];
  readonly timezone: string;
}): {
  readonly state: 'READY' | 'PARTIAL';
  readonly items: readonly VivaExerciseRecommendation[];
  readonly metadata: TrainingEventCatalogMetadata;
} {
  const completedDates = new Set(input.completedDates);
  const requestedDates = new Set(input.query.localDates);
  const categoryIds = new Set(input.query.categoryIds ?? []);
  const stationIds = new Set(input.query.stationIds ?? []);
  const kinds = new Set(input.query.kinds);
  const startsAfter = input.query.startsAfterLocal
    ? Number(input.query.startsAfterLocal.slice(0, 2)) * 60 +
      Number(input.query.startsAfterLocal.slice(3))
    : undefined;
  const byId = new Map(
    input.activities
      .filter(isGroupTrainingCatalogActivity)
      .map((activity) => [activity.id, activity] as const),
  );
  const baseItems = [...byId.values()].filter((activity) => {
    const local = localDateAndMinutes(activity, input.timezone);
    return (
      requestedDates.has(local.date) &&
      (input.query.availability === 'INCLUDE_FULL' || activity.capacity.open !== 0) &&
      matchesLevel(activity, input.query) &&
      (startsAfter === undefined || local.minutes >= startsAfter)
    );
  });
  const matchesCategory = (activity: VivaExerciseRecommendation): boolean =>
    categoryIds.size === 0 || (!!activity.category && categoryIds.has(activity.category.id));
  const matchesStation = (activity: VivaExerciseRecommendation): boolean =>
    stationIds.size === 0 || stationIds.has(activity.station.id);
  const matchesKind = (activity: VivaExerciseRecommendation): boolean =>
    kinds.has(trainingCatalogKind(activity));
  const items = baseItems
    .filter(
      (activity) => matchesKind(activity) && matchesCategory(activity) && matchesStation(activity),
    )
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        TRAINING_KIND_RANK[trainingCatalogKind(left)] -
          TRAINING_KIND_RANK[trainingCatalogKind(right)] ||
        left.id.localeCompare(right.id),
    );
  const state = input.query.localDates.every((date) => completedDates.has(date))
    ? 'READY'
    : 'PARTIAL';
  const counts = <T extends { readonly id: string; readonly name: string }>(values: readonly T[]) =>
    [...new Map(values.map((value) => [value.id, value])).values()]
      .map((value) => ({
        ...value,
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
                  .filter((activity) => matchesKind(activity) && matchesStation(activity))
                  .flatMap((activity) => (activity.category ? [activity.category] : [])),
              ),
              stations: counts(
                baseItems
                  .filter((activity) => matchesKind(activity) && matchesCategory(activity))
                  .map((activity) => activity.station),
              ),
              kinds: TRAINING_KINDS.flatMap((kind) => {
                const count = baseItems.filter(
                  (activity) =>
                    trainingCatalogKind(activity) === kind &&
                    matchesCategory(activity) &&
                    matchesStation(activity),
                ).length;
                return count > 0 ? [{ kind, count }] : [];
              }),
            }
          : null,
      sourceStatus: input.query.localDates.map((date) => ({
        source: 'SCHEDULE',
        localDate: date,
        state: completedDates.has(date) ? 'READY' : 'UNAVAILABLE',
        errorCode: completedDates.has(date) ? null : 'SCHEDULE_READ_INCOMPLETE',
      })),
    },
  };
}
