import { createHash } from 'node:crypto';

import type { GameRepository, StoredGameCardProjection } from '@phub/database';
import type { BookingPreferences, BookingPreferenceWeekday } from '@phub/domain';
import {
  GAME_PLAYER_LEVELS,
  projectGameCard,
  type GameCardView,
  type GamePlayerLevel,
} from '@phub/games';

type CardReadRepository = Pick<GameRepository, 'listRecommendationCardProjections'>;

export const BOOKING_RECOMMENDATION_REASONS = [
  'LEVEL_MATCH',
  'FAVORITE_STATION',
  'PLAYED_STATION',
  'PREFERRED_TIME',
  'USUAL_TIME',
  'AVAILABLE_SOON',
] as const;
export type BookingRecommendationReason = (typeof BOOKING_RECOMMENDATION_REASONS)[number];

export interface BookingRecommendationItem {
  readonly game: GameCardView;
  readonly reasons: readonly BookingRecommendationReason[];
}

export interface BookingRecommendationPage {
  readonly version: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly personalization: 'EXPLICIT' | 'LEARNED' | 'BASIC';
  readonly items: readonly BookingRecommendationItem[];
  readonly nextCursor: null;
}

interface LocalSlot {
  readonly weekday: BookingPreferenceWeekday;
  readonly minuteOfDay: number;
  readonly timeBucket: string;
}

const WEEKDAY: Readonly<Record<string, BookingPreferenceWeekday>> = {
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
};

function levelIndex(level: GamePlayerLevel): number {
  return GAME_PLAYER_LEVELS.indexOf(level);
}

function localSlot(value: string, timezone: string): LocalSlot {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAY[parts.weekday ?? ''] ?? 'MON';
  const hour = Number(parts.hour ?? 0);
  const minute = Number(parts.minute ?? 0);
  return {
    weekday,
    minuteOfDay: hour * 60 + minute,
    timeBucket: `${weekday}:${Math.floor(hour / 2)}`,
  };
}

function minutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

function fitsLevel(game: GameCardView, playerLevel: GamePlayerLevel | null): boolean {
  if (!playerLevel || !game.levelRange) return true;
  const player = levelIndex(playerLevel);
  const from = game.levelRange.from ? levelIndex(game.levelRange.from) : 0;
  const to = game.levelRange.to ? levelIndex(game.levelRange.to) : GAME_PLAYER_LEVELS.length - 1;
  return player >= from && player <= to;
}

function levelScore(game: GameCardView, playerLevel: GamePlayerLevel | null): number {
  if (!playerLevel) return 0.5;
  if (!game.levelRange) return 0.7;
  const from = game.levelRange.from ? levelIndex(game.levelRange.from) : 0;
  const to = game.levelRange.to ? levelIndex(game.levelRange.to) : GAME_PLAYER_LEVELS.length - 1;
  const distance = Math.abs(levelIndex(playerLevel) - (from + to) / 2);
  return Math.max(0.65, 1 - distance * 0.12);
}

function completedHistory(input: {
  readonly history: readonly GameCardView[];
  readonly now: string;
}): readonly GameCardView[] {
  const cutoff = Date.parse(input.now) - 180 * 24 * 60 * 60 * 1_000;
  return input.history.filter(
    (game) => game.displayState === 'COMPLETED' && Date.parse(game.startsAt) >= cutoff,
  );
}

function affinityMaps(
  history: readonly GameCardView[],
  now: string,
): {
  readonly stations: ReadonlyMap<string, number>;
  readonly times: ReadonlyMap<string, number>;
} {
  const stations = new Map<string, number>();
  const times = new Map<string, number>();
  const nowMs = Date.parse(now);
  for (const game of history) {
    const ageDays = Math.max(0, (nowMs - Date.parse(game.startsAt)) / (24 * 60 * 60 * 1_000));
    const weight = 0.5 ** (ageDays / 45);
    stations.set(game.station.id, (stations.get(game.station.id) ?? 0) + weight);
    const slot = localSlot(game.startsAt, game.timezone);
    times.set(slot.timeBucket, (times.get(slot.timeBucket) ?? 0) + weight);
  }
  return { stations, times };
}

function normalizedAffinity(map: ReadonlyMap<string, number>, key: string): number {
  const maximum = Math.max(0, ...map.values());
  if (maximum === 0) return 0;
  return (map.get(key) ?? 0) / maximum;
}

function explicitTimeMatch(game: GameCardView, preferences: BookingPreferences): boolean {
  const slot = localSlot(game.startsAt, game.timezone);
  return preferences.preferredTimeWindows.some(
    (window) =>
      window.weekday === slot.weekday &&
      slot.minuteOfDay >= minutes(window.startsAt) &&
      slot.minuteOfDay < minutes(window.endsAt),
  );
}

function personalizationMode(
  preferences: BookingPreferences,
  history: readonly GameCardView[],
): BookingRecommendationPage['personalization'] {
  if (preferences.favoriteStationIds.length > 0 || preferences.preferredTimeWindows.length > 0) {
    return 'EXPLICIT';
  }
  return preferences.useHistory && history.length >= 3 ? 'LEARNED' : 'BASIC';
}

function rankGames(input: {
  readonly candidates: readonly GameCardView[];
  readonly history: readonly GameCardView[];
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly now: string;
  readonly limit: number;
}): readonly BookingRecommendationItem[] {
  const usefulHistory = input.preferences.useHistory
    ? completedHistory({ history: input.history, now: input.now })
    : [];
  const affinity = affinityMaps(usefulHistory, input.now);
  const favoriteStations = new Set(input.preferences.favoriteStationIds);

  return input.candidates
    .filter(
      (game) =>
        game.viewerRelation === 'NONE' &&
        game.allowedActions.some((action) => action === 'JOIN' || action === 'JOIN_WAITLIST') &&
        fitsLevel(game, input.playerLevel),
    )
    .map((game) => {
      const reasons: BookingRecommendationReason[] = [];
      const level = levelScore(game, input.playerLevel);
      if (input.playerLevel && game.levelRange) reasons.push('LEVEL_MATCH');

      const stationHistory = normalizedAffinity(affinity.stations, game.station.id);
      const station = favoriteStations.has(game.station.id)
        ? 1
        : favoriteStations.size > 0
          ? Math.max(0.15, stationHistory * 0.7)
          : stationHistory > 0
            ? stationHistory
            : 0.5;
      if (favoriteStations.has(game.station.id)) reasons.push('FAVORITE_STATION');
      else if (stationHistory >= 0.5) reasons.push('PLAYED_STATION');

      const preferredTime = explicitTimeMatch(game, input.preferences);
      const slot = localSlot(game.startsAt, game.timezone);
      const timeHistory = normalizedAffinity(affinity.times, slot.timeBucket);
      const time =
        input.preferences.preferredTimeWindows.length > 0
          ? preferredTime
            ? 1
            : Math.max(0.15, timeHistory * 0.7)
          : timeHistory > 0
            ? timeHistory
            : 0.5;
      if (preferredTime) reasons.push('PREFERRED_TIME');
      else if (timeHistory >= 0.5) reasons.push('USUAL_TIME');
      if (reasons.length === 0) reasons.push('AVAILABLE_SOON');

      return {
        item: { game, reasons },
        score: level * 0.45 + station * 0.3 + time * 0.25,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(left.item.game.startsAt) - Date.parse(right.item.game.startsAt) ||
        left.item.game.id.localeCompare(right.item.game.id),
    )
    .slice(0, input.limit)
    .map(({ item }) => item);
}

export async function listBookingRecommendations(input: {
  readonly repository: CardReadRepository;
  readonly tenantId: string;
  readonly userId: string;
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly now: string;
  readonly limit: number;
}): Promise<BookingRecommendationPage> {
  const projectionInputs = await input.repository.listRecommendationCardProjections({
    tenantId: input.tenantId,
    viewerUserId: input.userId,
    candidateLimit: 100,
    historyLimit: 50,
  });
  const candidates = projectionInputs.candidates.map((projection) =>
    projectGameCard(projection.basePayload, {
      surface: 'DISCOVER',
      now: input.now,
      viewerUserId: input.userId,
    }),
  );
  const history = projectionInputs.history.map((projection) =>
    projectGameCard(projection.basePayload, {
      surface: 'HISTORY',
      now: input.now,
      viewerUserId: input.userId,
    }),
  );
  const items = rankGames({ ...input, candidates, history });
  const version = createHash('sha256')
    .update(
      JSON.stringify({
        preferenceVersion: input.preferences.version,
        playerLevel: input.playerLevel,
        candidates: projectionInputs.candidates.map((item: StoredGameCardProjection) => [
          item.gameId,
          item.projectionRevision,
        ]),
        history: projectionInputs.history.map((item: StoredGameCardProjection) => [
          item.gameId,
          item.projectionRevision,
        ]),
      }),
    )
    .digest('hex');
  const generatedAt = new Date(input.now).toISOString();
  return {
    version,
    generatedAt,
    staleAt: new Date(Date.parse(generatedAt) + 5 * 60 * 1_000).toISOString(),
    personalization: personalizationMode(
      input.preferences,
      completedHistory({ history, now: input.now }),
    ),
    items,
    nextCursor: null,
  };
}
