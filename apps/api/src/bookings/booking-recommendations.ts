import { createHash } from 'node:crypto';

import type {
  GameRepository,
  ProfileSummaryRepository,
  StoredGameCardProjection,
} from '@phub/database';
import type { BookingPreferences, BookingPreferenceWeekday } from '@phub/domain';
import {
  GAME_PLAYER_LEVELS,
  projectGameCard,
  type GameCardView,
  type GamePlayerLevel,
} from '@phub/games';
import type { PublicTournamentSummary } from '@phub/legacy-games-adapter';
import type { VivaExerciseRecommendation } from '@phub/viva-adapter';

import {
  gameCardProfilePhotoUserIds,
  stabilizeGameCardProfilePhotos,
} from '../profile/profile-photo-url.js';

type CardReadRepository = Pick<GameRepository, 'listRecommendationCardProjections'>;

export const BOOKING_RECOMMENDATION_REASONS = [
  'LEVEL_MATCH',
  'FRIEND_PLAYING',
  'FAVORITE_STATION',
  'PLAYED_STATION',
  'PREFERRED_TIME',
  'USUAL_TIME',
  'AVAILABLE_SOON',
] as const;
export type BookingRecommendationReason = (typeof BOOKING_RECOMMENDATION_REASONS)[number];

export interface BookingRecommendationGameItem {
  readonly kind: 'GAME';
  readonly game: GameCardView;
  readonly reasons: readonly BookingRecommendationReason[];
}

export interface BookingRecommendationActivity {
  readonly id: string;
  readonly kind: 'TRAINING' | 'TOURNAMENT';
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly station: {
    readonly id: string;
    readonly name: string;
    readonly shortAddress: string | null;
  };
  readonly court?: {
    readonly id: string;
    readonly name: string;
  } | null;
  readonly category?: {
    readonly id: string;
    readonly name: string;
  } | null;
  readonly levelRange: {
    readonly from: GamePlayerLevel;
    readonly to: GamePlayerLevel;
  } | null;
  readonly capacity: {
    readonly total: number | null;
    readonly open: number | null;
  };
  readonly host: {
    readonly displayName: string;
    readonly avatarUrl: string | null;
    readonly role: 'TRAINER' | 'ORGANIZER';
  } | null;
  readonly route: string;
}

export interface BookingRecommendationActivityItem {
  readonly kind: 'TRAINING' | 'TOURNAMENT';
  readonly activity: BookingRecommendationActivity;
  readonly reasons: readonly BookingRecommendationReason[];
}

export type BookingRecommendationItem =
  BookingRecommendationGameItem | BookingRecommendationActivityItem;

export interface BookingRecommendationPage {
  readonly version: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly personalization: 'EXPLICIT' | 'LEARNED' | 'BASIC';
  readonly items: readonly BookingRecommendationItem[];
  readonly nextCursor: string | null;
}

interface LocalSlot {
  readonly weekday: BookingPreferenceWeekday;
  readonly minuteOfDay: number;
  readonly timeBucket: string;
}

interface RankableEvent {
  readonly id: string;
  readonly startsAt: string;
  readonly timezone: string;
  readonly station: {
    readonly id: string;
    readonly name: string;
  };
  readonly levelRange: {
    readonly from: GamePlayerLevel | null;
    readonly to: GamePlayerLevel | null;
  } | null;
}

interface ScoredRecommendation {
  readonly item: BookingRecommendationItem;
  readonly score: number;
  readonly startsAt: string;
  readonly id: string;
}

interface BookingRecommendationCursor {
  readonly v: 1;
  readonly version: string;
  readonly offset: number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RECOMMENDATION_FEED_CACHE_MAX_ENTRIES = 500;

interface CachedBookingRecommendationFeed {
  readonly version: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly personalization: BookingRecommendationPage['personalization'];
  readonly items: readonly BookingRecommendationItem[];
}

const recommendationFeedCache = new Map<string, CachedBookingRecommendationFeed>();

function encodeCursor(cursor: BookingRecommendationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): BookingRecommendationCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'offset,v,version' ||
      record.v !== 1 ||
      typeof record.version !== 'string' ||
      !HASH_PATTERN.test(record.version) ||
      typeof record.offset !== 'number' ||
      !Number.isInteger(record.offset) ||
      record.offset < 1 ||
      record.offset > 10_000
    ) {
      throw new Error('fields');
    }
    return record as unknown as BookingRecommendationCursor;
  } catch {
    throw new Error('BOOKING_RECOMMENDATION_CURSOR_INVALID');
  }
}

function recommendationFeedCacheKey(tenantId: string, userId: string, version: string): string {
  return `${tenantId}:${userId}:${version}`;
}

function cacheRecommendationFeed(
  tenantId: string,
  userId: string,
  feed: CachedBookingRecommendationFeed,
): void {
  const now = Date.parse(feed.generatedAt);
  for (const [key, cached] of recommendationFeedCache) {
    if (Date.parse(cached.staleAt) < now) recommendationFeedCache.delete(key);
  }
  while (recommendationFeedCache.size >= RECOMMENDATION_FEED_CACHE_MAX_ENTRIES) {
    const oldestKey = recommendationFeedCache.keys().next().value;
    if (!oldestKey) break;
    recommendationFeedCache.delete(oldestKey);
  }
  recommendationFeedCache.set(recommendationFeedCacheKey(tenantId, userId, feed.version), feed);
}

function pageFromFeed(
  feed: CachedBookingRecommendationFeed,
  offset: number,
  limit: number,
): BookingRecommendationPage {
  if (offset > feed.items.length) throw new Error('BOOKING_RECOMMENDATION_CURSOR_INVALID');
  const items = feed.items.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    version: feed.version,
    generatedAt: feed.generatedAt,
    staleAt: feed.staleAt,
    personalization: feed.personalization,
    items,
    nextCursor:
      nextOffset < feed.items.length
        ? encodeCursor({ v: 1, version: feed.version, offset: nextOffset })
        : null,
  };
}

function compareRecommendations(left: ScoredRecommendation, right: ScoredRecommendation): number {
  return (
    right.score - left.score ||
    Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareRecommendationSchedule(
  left: ScoredRecommendation,
  right: ScoredRecommendation,
): number {
  return Date.parse(left.startsAt) - Date.parse(right.startsAt) || left.id.localeCompare(right.id);
}

function recommendationIdentity(recommendation: ScoredRecommendation): string {
  return `${recommendation.item.kind}:${recommendation.id}`;
}

function recommendationItemIdentity(recommendation: BookingRecommendationItem): string {
  return recommendation.kind === 'GAME'
    ? `GAME:${recommendation.game.id}`
    : `${recommendation.kind}:${recommendation.activity.id}`;
}

function selectDiverseRecommendations(
  recommendations: readonly ScoredRecommendation[],
  limit: number,
): readonly BookingRecommendationItem[] {
  const ranked = [...recommendations].sort(compareRecommendations);
  if (limit < 3) {
    return ranked
      .slice(0, limit)
      .sort(compareRecommendationSchedule)
      .map(({ item }) => item);
  }

  const anchors = (['TRAINING', 'TOURNAMENT'] as const).flatMap((kind) => {
    const recommendation = ranked.find((candidate) => candidate.item.kind === kind);
    return recommendation ? [recommendation] : [];
  });
  const selected = [...anchors];
  const selectedIds = new Set(selected.map(recommendationIdentity));
  for (const recommendation of ranked) {
    if (selected.length >= limit) break;
    const identity = recommendationIdentity(recommendation);
    if (selectedIds.has(identity)) continue;
    selected.push(recommendation);
    selectedIds.add(identity);
  }
  return selected.sort(compareRecommendationSchedule).map(({ item }) => item);
}

function buildPaginatedRecommendationFeed(
  recommendations: readonly ScoredRecommendation[],
  firstPageSize: number,
): readonly BookingRecommendationItem[] {
  const feed: BookingRecommendationItem[] = [];
  let remaining = [...recommendations];
  let batchSize = firstPageSize;
  while (remaining.length > 0) {
    const batch = selectDiverseRecommendations(remaining, batchSize);
    if (batch.length === 0) break;
    feed.push(...batch);
    const selected = new Set(batch.map(recommendationItemIdentity));
    remaining = remaining.filter(
      (recommendation) => !selected.has(recommendationIdentity(recommendation)),
    );
    batchSize = 12;
  }
  return feed;
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

function fitsLevel(event: RankableEvent, playerLevel: GamePlayerLevel | null): boolean {
  if (!playerLevel || !event.levelRange) return true;
  const player = levelIndex(playerLevel);
  const from = event.levelRange.from ? levelIndex(event.levelRange.from) : 0;
  const to = event.levelRange.to ? levelIndex(event.levelRange.to) : GAME_PLAYER_LEVELS.length - 1;
  return player >= from && player <= to;
}

function levelScore(event: RankableEvent, playerLevel: GamePlayerLevel | null): number {
  if (!playerLevel) return 0.5;
  if (!event.levelRange) return 0.7;
  const from = event.levelRange.from ? levelIndex(event.levelRange.from) : 0;
  const to = event.levelRange.to ? levelIndex(event.levelRange.to) : GAME_PLAYER_LEVELS.length - 1;
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
  readonly stationNames: ReadonlyMap<string, number>;
  readonly times: ReadonlyMap<string, number>;
} {
  const stations = new Map<string, number>();
  const stationNames = new Map<string, number>();
  const times = new Map<string, number>();
  const nowMs = Date.parse(now);
  for (const game of history) {
    const ageDays = Math.max(0, (nowMs - Date.parse(game.startsAt)) / (24 * 60 * 60 * 1_000));
    const weight = 0.5 ** (ageDays / 45);
    stations.set(game.station.id, (stations.get(game.station.id) ?? 0) + weight);
    const stationName = normalizeStationName(game.station.name);
    stationNames.set(stationName, (stationNames.get(stationName) ?? 0) + weight);
    const slot = localSlot(game.startsAt, game.timezone);
    times.set(slot.timeBucket, (times.get(slot.timeBucket) ?? 0) + weight);
  }
  return { stations, stationNames, times };
}

function normalizedAffinity(map: ReadonlyMap<string, number>, key: string): number {
  const maximum = Math.max(0, ...map.values());
  if (maximum === 0) return 0;
  return (map.get(key) ?? 0) / maximum;
}

function normalizeStationName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-z0-9а-я]+/g, '');
}

function explicitTimeMatch(event: RankableEvent, preferences: BookingPreferences): boolean {
  const slot = localSlot(event.startsAt, event.timezone);
  return preferences.preferredTimeWindows.some(
    (window) =>
      (window.weekday === 'ANY' || window.weekday === slot.weekday) &&
      slot.minuteOfDay >= minutes(window.startsAt) &&
      slot.minuteOfDay < minutes(window.endsAt),
  );
}

function scoreEvent(input: {
  readonly event: RankableEvent;
  readonly affinity: ReturnType<typeof affinityMaps>;
  readonly favoriteStations: ReadonlySet<string>;
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly friendMatch: boolean;
}): { readonly reasons: readonly BookingRecommendationReason[]; readonly score: number } {
  const reasons: BookingRecommendationReason[] = [];
  const level = levelScore(input.event, input.playerLevel);
  if (input.playerLevel && input.event.levelRange) reasons.push('LEVEL_MATCH');
  if (input.preferences.recommendFriends && input.friendMatch) reasons.push('FRIEND_PLAYING');

  const stationHistory = Math.max(
    normalizedAffinity(input.affinity.stations, input.event.station.id),
    normalizedAffinity(input.affinity.stationNames, normalizeStationName(input.event.station.name)),
  );
  const station = input.favoriteStations.has(input.event.station.id)
    ? 1
    : input.favoriteStations.size > 0
      ? Math.max(0.15, stationHistory * 0.7)
      : stationHistory > 0
        ? stationHistory
        : 0.5;
  if (input.favoriteStations.has(input.event.station.id)) reasons.push('FAVORITE_STATION');
  else if (stationHistory >= 0.5) reasons.push('PLAYED_STATION');

  const preferredTime = explicitTimeMatch(input.event, input.preferences);
  const slot = localSlot(input.event.startsAt, input.event.timezone);
  const timeHistory = normalizedAffinity(input.affinity.times, slot.timeBucket);
  const hasTimeHistory = input.preferences.useHistory && input.affinity.times.size > 0;
  const time =
    input.preferences.preferredTimeWindows.length > 0
      ? preferredTime
        ? hasTimeHistory
          ? 0.75 + timeHistory * 0.25
          : 1
        : Math.max(0.15, timeHistory * 0.7)
      : timeHistory > 0
        ? timeHistory
        : 0.5;
  if (preferredTime) reasons.push('PREFERRED_TIME');
  else if (timeHistory >= 0.5) reasons.push('USUAL_TIME');
  if (reasons.length === 0) reasons.push('AVAILABLE_SOON');

  const friendBoost = input.preferences.recommendFriends && input.friendMatch ? 0.2 : 0;
  return { reasons, score: level * 0.45 + station * 0.3 + time * 0.25 + friendBoost };
}

function personalizationMode(
  preferences: BookingPreferences,
  history: readonly GameCardView[],
): BookingRecommendationPage['personalization'] {
  const hasNonDefaultTimeWindow =
    preferences.preferredTimeWindows.length > 0 &&
    (preferences.preferredTimeWindows.length !== 1 ||
      preferences.preferredTimeWindows[0]?.weekday !== 'ANY' ||
      preferences.preferredTimeWindows[0]?.startsAt !== '09:00' ||
      preferences.preferredTimeWindows[0]?.endsAt !== '22:00');
  if (preferences.favoriteStationIds.length > 0 || hasNonDefaultTimeWindow) {
    return 'EXPLICIT';
  }
  return preferences.useHistory && history.length >= 3 ? 'LEARNED' : 'BASIC';
}

function rankGames(input: {
  readonly candidates: readonly GameCardView[];
  readonly history: readonly GameCardView[];
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly friendUserIds: ReadonlySet<string>;
  readonly now: string;
}): readonly ScoredRecommendation[] {
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
      const ranked = scoreEvent({
        event: game,
        affinity,
        favoriteStations,
        preferences: input.preferences,
        playerLevel: input.playerLevel,
        friendMatch: game.participants.some((participant) =>
          input.friendUserIds.has(participant.userId),
        ),
      });
      return {
        item: { kind: 'GAME' as const, game, reasons: ranked.reasons },
        score: ranked.score,
        startsAt: game.startsAt,
        id: game.id,
      };
    });
}

function trainingActivityFromSource(
  activity: VivaExerciseRecommendation,
): BookingRecommendationActivity | undefined {
  if (activity.kind !== 'TRAINING') return undefined;
  const from = activity.levelRange?.from;
  const to = activity.levelRange?.to;
  if (
    (from && !GAME_PLAYER_LEVELS.includes(from as GamePlayerLevel)) ||
    (to && !GAME_PLAYER_LEVELS.includes(to as GamePlayerLevel))
  ) {
    return undefined;
  }
  return {
    ...activity,
    levelRange: from && to ? { from: from as GamePlayerLevel, to: to as GamePlayerLevel } : null,
  };
}

function stableTournamentStationId(venue: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`phub-public-tournament-station-v1:${venue}`).digest('hex'),
    'hex',
  ).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tournamentActivityFromSource(
  tournament: PublicTournamentSummary,
): BookingRecommendationActivity {
  const host = tournament.organizer
    ? { ...tournament.organizer, role: 'ORGANIZER' as const }
    : tournament.trainerName
      ? {
          displayName: tournament.trainerName,
          avatarUrl: null,
          role: 'ORGANIZER' as const,
        }
      : null;
  return {
    id: tournament.id,
    kind: 'TOURNAMENT',
    title: tournament.title,
    startsAt: tournament.startsAt,
    endsAt: tournament.endsAt,
    timezone: 'Europe/Moscow',
    station: {
      id: stableTournamentStationId(tournament.venue),
      name: tournament.venue,
      shortAddress: null,
    },
    levelRange: tournament.levelRange,
    capacity: {
      total: tournament.capacity.total,
      open: tournament.capacity.open,
    },
    host,
    route: tournament.route,
  };
}

function rankActivities(input: {
  readonly activities: readonly BookingRecommendationActivity[];
  readonly history: readonly GameCardView[];
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly now: string;
}): readonly ScoredRecommendation[] {
  const usefulHistory = input.preferences.useHistory
    ? completedHistory({ history: input.history, now: input.now })
    : [];
  const affinity = affinityMaps(usefulHistory, input.now);
  const favoriteStations = new Set(input.preferences.favoriteStationIds);
  return input.activities.flatMap((activity) => {
    if (
      Date.parse(activity.startsAt) < Date.parse(input.now) ||
      activity.capacity.open === 0 ||
      !fitsLevel(activity, input.playerLevel)
    ) {
      return [];
    }
    const ranked = scoreEvent({
      event: activity,
      affinity,
      favoriteStations,
      preferences: input.preferences,
      playerLevel: input.playerLevel,
      friendMatch: false,
    });
    return [
      {
        item: { kind: activity.kind, activity, reasons: ranked.reasons },
        score: ranked.score,
        startsAt: activity.startsAt,
        id: activity.id,
      },
    ];
  });
}

export async function listBookingRecommendations(input: {
  readonly repository: CardReadRepository;
  readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
  readonly tenantId: string;
  readonly userId: string;
  readonly preferences: BookingPreferences;
  readonly playerLevel: GamePlayerLevel | null;
  readonly friendUserIds?: readonly string[];
  readonly activities?: readonly VivaExerciseRecommendation[];
  readonly tournaments?: readonly PublicTournamentSummary[];
  readonly now: string;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<BookingRecommendationPage> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (cursor) {
    const cachedFeed = recommendationFeedCache.get(
      recommendationFeedCacheKey(input.tenantId, input.userId, cursor.version),
    );
    if (cachedFeed && Date.parse(cachedFeed.staleAt) >= Date.parse(input.now)) {
      return pageFromFeed(cachedFeed, cursor.offset, input.limit);
    }
  }
  const projectionInputs = await input.repository.listRecommendationCardProjections({
    tenantId: input.tenantId,
    viewerUserId: input.userId,
    candidateLimit: 100,
    historyLimit: 50,
  });
  const deliveryIds = input.photoRepository
    ? await input.photoRepository.getPhotoDeliveryIds(
        input.tenantId,
        [...projectionInputs.candidates, ...projectionInputs.history].flatMap((projection) =>
          gameCardProfilePhotoUserIds(projection.basePayload),
        ),
      )
    : new Map<string, string>();
  const candidates = projectionInputs.candidates.map((projection) =>
    projectGameCard(
      stabilizeGameCardProfilePhotos(projection.basePayload, input.tenantId, deliveryIds),
      {
        surface: 'DISCOVER',
        now: input.now,
        viewerUserId: input.userId,
      },
    ),
  );
  const history = projectionInputs.history.map((projection) =>
    projectGameCard(
      stabilizeGameCardProfilePhotos(projection.basePayload, input.tenantId, deliveryIds),
      {
        surface: 'HISTORY',
        now: input.now,
        viewerUserId: input.userId,
      },
    ),
  );
  const rankedGames = rankGames({
    ...input,
    candidates,
    history,
    friendUserIds: new Set(input.friendUserIds ?? []),
  });
  const activities = [
    ...(input.activities ?? []).flatMap((activity) => {
      const normalized = trainingActivityFromSource(activity);
      return normalized ? [normalized] : [];
    }),
    ...(input.tournaments ?? []).map(tournamentActivityFromSource),
  ];
  const rankedActivities = rankActivities({
    ...input,
    activities,
    history,
  });
  const rankedRecommendations = [...rankedGames, ...rankedActivities];
  const feedItems = buildPaginatedRecommendationFeed(rankedRecommendations, input.limit);
  const version = createHash('sha256')
    .update(
      JSON.stringify({
        preferenceVersion: input.preferences.version,
        friendUserIds: input.preferences.recommendFriends
          ? [...(input.friendUserIds ?? [])].sort()
          : [],
        playerLevel: input.playerLevel,
        candidates: projectionInputs.candidates.map((item: StoredGameCardProjection) => [
          item.gameId,
          item.projectionRevision,
        ]),
        history: projectionInputs.history.map((item: StoredGameCardProjection) => [
          item.gameId,
          item.projectionRevision,
        ]),
        activities: (input.activities ?? []).map((item) => [
          item.id,
          item.startsAt,
          item.capacity.open,
        ]),
        tournaments: (input.tournaments ?? []).map((item) => [
          item.id,
          item.startsAt,
          item.capacity.open,
        ]),
        feed: feedItems.map((item) =>
          item.kind === 'GAME' ? ['GAME', item.game.id] : [item.kind, item.activity.id],
        ),
      }),
    )
    .digest('hex');
  if (cursor && cursor.version !== version) {
    throw new Error('BOOKING_RECOMMENDATION_CURSOR_INVALID');
  }
  const generatedAt = new Date(input.now).toISOString();
  const feed: CachedBookingRecommendationFeed = {
    version,
    generatedAt,
    staleAt: new Date(Date.parse(generatedAt) + 5 * 60 * 1_000).toISOString(),
    personalization: personalizationMode(
      input.preferences,
      completedHistory({ history, now: input.now }),
    ),
    items: feedItems,
  };
  cacheRecommendationFeed(input.tenantId, input.userId, feed);
  return pageFromFeed(feed, cursor?.offset ?? 0, input.limit);
}
