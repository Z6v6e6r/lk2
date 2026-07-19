import { createHash } from 'node:crypto';

import type { GameKind, GamePaymentState, GamePlayerLevel, GameVisibility } from '@phub/games';
import { MongoClient, type Document, type Filter } from 'mongodb';

export interface LegacyGameSourceParticipant {
  readonly externalId: string;
  readonly displayName: string;
  readonly level: GamePlayerLevel | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly paymentState: Extract<GamePaymentState, 'NOT_REQUIRED' | 'PAID'>;
}

export interface LegacyGameSourceSnapshot {
  readonly externalId: string;
  readonly externalVersion: string;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly cancelled: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: 'Europe/Moscow';
  readonly station: {
    readonly externalId: string;
    readonly name: string;
    readonly courtExternalId: string | null;
    readonly courtName: string | null;
  };
  readonly capacity: 2 | 4;
  readonly waitlistEnabled: boolean;
  readonly paymentMode: 'ORGANIZER_PAYS' | 'SPLIT';
  readonly levelFrom: GamePlayerLevel | null;
  readonly levelTo: GamePlayerLevel | null;
  readonly organizerExternalId: string;
  readonly participants: readonly LegacyGameSourceParticipant[];
}

export interface LegacyGamesMongoAdapterOptions {
  readonly uri: string;
  readonly dbName?: string;
  readonly collectionName?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onMetric?: (metric: {
    readonly outcome: 'success' | 'failure' | 'retry';
    readonly attempt: number;
    readonly durationMs: number;
  }) => void;
}

interface RawParticipant {
  readonly [key: string]: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly rating?: unknown;
  readonly ratingNumeric?: unknown;
  readonly status?: unknown;
}

interface RawLegacyGame extends Document {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly archived?: unknown;
  readonly updatedAt?: unknown;
  readonly organizer?: RawParticipant;
  readonly participants?: readonly RawParticipant[];
  readonly settings?: {
    readonly [key: string]: unknown;
    readonly isPrivate?: unknown;
    readonly minRating?: unknown;
    readonly maxRating?: unknown;
    readonly payMode?: unknown;
    readonly ratingGame?: unknown;
  };
  readonly metadata?: {
    readonly [key: string]: unknown;
    readonly gameFormat?: unknown;
    readonly gameTitle?: unknown;
  };
  readonly booking?: {
    readonly [key: string]: unknown;
    readonly studioId?: unknown;
    readonly studioName?: unknown;
    readonly roomId?: unknown;
    readonly roomName?: unknown;
    readonly timeFromIso?: unknown;
    readonly timeToIso?: unknown;
  };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function playerLevel(value: unknown): GamePlayerLevel | null {
  const label = stringValue(value)?.toUpperCase();
  if (label && ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'].includes(label)) {
    return label as GamePlayerLevel;
  }
  const rating = numericValue(value);
  if (rating === undefined) return null;
  if (rating < 2) return 'D';
  if (rating < 3) return 'D+';
  if (rating < 3.5) return 'C';
  if (rating < 4) return 'C+';
  if (rating < 4.7) return 'B';
  if (rating < 5.5) return 'B+';
  return 'A';
}

function pseudonymousId(entityType: string, externalId: string): string {
  return createHash('sha256')
    .update(`phub-local-public-clone-v1:${entityType}:${externalId}`)
    .digest('hex');
}

function anonymizeSnapshot(snapshot: LegacyGameSourceSnapshot): LegacyGameSourceSnapshot {
  const participants = snapshot.participants.map((item, index) => ({
    ...item,
    externalId: pseudonymousId('player', item.externalId),
    displayName: item.role === 'ORGANIZER' ? 'Организатор' : `Игрок ${index + 1}`,
  }));
  return {
    ...snapshot,
    externalId: pseudonymousId('game', snapshot.externalId),
    title: `${snapshot.kind === 'RATING' ? 'Рейтинговая' : 'Открытая'} игра ${snapshot.capacity === 2 ? '1×1' : '2×2'}`,
    station: {
      ...snapshot.station,
      externalId: pseudonymousId('station', snapshot.station.externalId),
      courtExternalId: snapshot.station.courtExternalId
        ? pseudonymousId('court', snapshot.station.courtExternalId)
        : null,
    },
    organizerExternalId: pseudonymousId('player', snapshot.organizerExternalId),
    participants,
  };
}

function isoInstant(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function participant(
  raw: RawParticipant,
  organizerExternalId: string,
): LegacyGameSourceParticipant | undefined {
  const externalId = stringValue(raw.id);
  const displayName = stringValue(raw.name);
  if (!externalId || !displayName) return undefined;
  return {
    externalId,
    displayName,
    level: playerLevel(raw.ratingNumeric ?? raw.rating),
    role: externalId === organizerExternalId ? 'ORGANIZER' : 'PLAYER',
    paymentState: 'PAID',
  };
}

function mapLegacyGame(raw: RawLegacyGame): LegacyGameSourceSnapshot | undefined {
  const externalId = stringValue(raw.id);
  const organizerExternalId = stringValue(raw.organizer?.id);
  const organizerName = stringValue(raw.organizer?.name);
  const startsAt = isoInstant(raw.booking?.timeFromIso);
  const endsAt = isoInstant(raw.booking?.timeToIso);
  const stationExternalId = stringValue(raw.booking?.studioId);
  const stationName = stringValue(raw.booking?.studioName);
  const legacyStatus = stringValue(raw.status);
  if (
    !externalId ||
    !organizerExternalId ||
    !organizerName ||
    !startsAt ||
    !endsAt ||
    Date.parse(endsAt) <= Date.parse(startsAt) ||
    !stationExternalId ||
    !stationName ||
    (legacyStatus !== 'PAID' && legacyStatus !== 'CANCELLED')
  ) {
    return undefined;
  }

  const organizer = participant(raw.organizer ?? {}, organizerExternalId) ?? {
    externalId: organizerExternalId,
    displayName: organizerName,
    level: playerLevel(raw.organizer?.ratingNumeric ?? raw.organizer?.rating),
    role: 'ORGANIZER' as const,
    paymentState: 'PAID' as const,
  };
  const participantMap = new Map<string, LegacyGameSourceParticipant>([
    [organizerExternalId, organizer],
  ]);
  for (const item of raw.participants ?? []) {
    const normalized = participant(item, organizerExternalId);
    if (normalized) participantMap.set(normalized.externalId, normalized);
  }
  const format = stringValue(raw.metadata?.gameFormat);
  const capacity: 2 | 4 = format === 'singles' ? 2 : 4;
  const participants = [...participantMap.values()].slice(0, capacity);
  const minRating = playerLevel(raw.settings?.minRating);
  const maxRating = playerLevel(raw.settings?.maxRating);
  const updatedAt = isoInstant(raw.updatedAt) ?? startsAt;
  const ratingGame = raw.settings?.ratingGame === true;
  const title =
    stringValue(raw.metadata?.gameTitle) ??
    `${ratingGame ? 'Рейтинговая' : 'Открытая'} игра ${capacity === 2 ? '1×1' : '2×2'}`;
  const visibility = raw.settings?.isPrivate === true ? 'PRIVATE' : 'PUBLIC';
  const station = {
    externalId: stationExternalId,
    name: stationName,
    courtExternalId: stringValue(raw.booking?.roomId) ?? null,
    courtName: stringValue(raw.booking?.roomName) ?? null,
  };
  const paymentMode = stringValue(raw.settings?.payMode) === 'split' ? 'SPLIT' : 'ORGANIZER_PAYS';
  const externalVersion = createHash('sha256')
    .update(
      JSON.stringify({
        updatedAt,
        legacyStatus,
        title,
        ratingGame,
        visibility,
        startsAt,
        endsAt,
        station,
        capacity,
        paymentMode,
        minRating,
        maxRating,
        participants,
      }),
    )
    .digest('hex');

  return {
    externalId,
    externalVersion,
    title,
    kind: ratingGame ? 'RATING' : 'FRIENDLY',
    visibility,
    cancelled: legacyStatus === 'CANCELLED',
    startsAt,
    endsAt,
    timezone: 'Europe/Moscow',
    station,
    capacity,
    waitlistEnabled: true,
    paymentMode,
    levelFrom: minRating,
    levelTo: maxRating,
    organizerExternalId,
    participants,
  };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LegacyGamesMongoAdapter {
  public constructor(private readonly options: LegacyGamesMongoAdapterOptions) {
    if (!options.uri.trim()) throw new Error('LEGACY_GAMES_MONGODB_URI_REQUIRED');
    const attempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2) {
      throw new Error('LEGACY_GAMES_MAX_ATTEMPTS_INVALID');
    }
  }

  public async read(input: {
    readonly from: string;
    readonly to: string;
    readonly limit: number;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
    const from = isoInstant(input.from);
    const to = isoInstant(input.to);
    if (!from || !to || Date.parse(to) <= Date.parse(from)) {
      throw new Error('LEGACY_GAMES_DATE_RANGE_INVALID');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error('LEGACY_GAMES_LIMIT_INVALID');
    }

    const attempts = this.options.maxAttempts ?? 2;
    const sleep = this.options.sleep ?? defaultSleep;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      const client = new MongoClient(this.options.uri, {
        serverSelectionTimeoutMS: this.options.timeoutMs ?? 5_000,
        connectTimeoutMS: this.options.timeoutMs ?? 5_000,
        socketTimeoutMS: this.options.timeoutMs ?? 5_000,
        maxPoolSize: 2,
        retryReads: true,
        readPreference: 'secondaryPreferred',
      });
      try {
        await client.connect();
        const filter: Filter<RawLegacyGame> = {
          archived: { $ne: true },
          status: { $in: ['PAID', 'CANCELLED'] },
          'booking.timeFromIso': { $gte: from, $lt: to },
        };
        const rows = await client
          .db(this.options.dbName ?? 'games')
          .collection<RawLegacyGame>(this.options.collectionName ?? 'lk_games')
          .find(filter, {
            projection: {
              id: 1,
              status: 1,
              updatedAt: 1,
              'organizer.id': 1,
              'organizer.name': 1,
              'organizer.rating': 1,
              'organizer.ratingNumeric': 1,
              'participants.id': 1,
              'participants.name': 1,
              'participants.rating': 1,
              'participants.ratingNumeric': 1,
              'participants.status': 1,
              'settings.isPrivate': 1,
              'settings.minRating': 1,
              'settings.maxRating': 1,
              'settings.payMode': 1,
              'settings.ratingGame': 1,
              'metadata.gameFormat': 1,
              'metadata.gameTitle': 1,
              'booking.studioId': 1,
              'booking.studioName': 1,
              'booking.roomId': 1,
              'booking.roomName': 1,
              'booking.timeFromIso': 1,
              'booking.timeToIso': 1,
            },
            maxTimeMS: this.options.timeoutMs ?? 5_000,
          })
          .sort({ 'booking.timeFromIso': 1, _id: 1 })
          .limit(input.limit)
          .toArray();
        const snapshots = rows.flatMap((row) => {
          const mapped = mapLegacyGame(row);
          return mapped ? [mapped] : [];
        });
        this.options.onMetric?.({
          outcome: 'success',
          attempt,
          durationMs: Date.now() - startedAt,
        });
        return snapshots;
      } catch (error) {
        this.options.onMetric?.({
          outcome: attempt < attempts ? 'retry' : 'failure',
          attempt,
          durationMs: Date.now() - startedAt,
        });
        if (attempt === attempts)
          throw new Error('LEGACY_GAMES_SOURCE_UNAVAILABLE', { cause: error });
        await sleep(100 * attempt);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    throw new Error('LEGACY_GAMES_SOURCE_UNAVAILABLE');
  }
}

export interface LegacyGamesPublicAdapterOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

export class LegacyGamesPublicAdapter {
  public constructor(private readonly options: LegacyGamesPublicAdapterOptions = {}) {}

  public async readAvailable(input: {
    readonly limit: number;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error('LEGACY_GAMES_LIMIT_INVALID');
    }
    const baseUrl = new URL(this.options.baseUrl ?? 'https://padlhub.su');
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
      throw new Error('LEGACY_GAMES_PUBLIC_BASE_URL_INVALID');
    }
    const url = new URL('/lk/games', baseUrl);
    url.searchParams.set('public', 'true');
    url.searchParams.set('available', 'true');
    url.searchParams.set('limit', String(input.limit));
    url.searchParams.set('offset', '0');
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new Error('LEGACY_GAMES_PUBLIC_SOURCE_UNAVAILABLE', { cause: error });
    }
    if (!response.ok) throw new Error('LEGACY_GAMES_PUBLIC_SOURCE_UNAVAILABLE');
    const maxResponseBytes = this.options.maxResponseBytes ?? 15 * 1_024 * 1_024;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw new Error('LEGACY_GAMES_PUBLIC_RESPONSE_TOO_LARGE');
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxResponseBytes) {
      throw new Error('LEGACY_GAMES_PUBLIC_RESPONSE_TOO_LARGE');
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('LEGACY_GAMES_PUBLIC_RESPONSE_INVALID');
    }
    const games =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as { readonly games?: unknown }).games
        : undefined;
    if (!Array.isArray(games)) throw new Error('LEGACY_GAMES_PUBLIC_RESPONSE_INVALID');
    return games.flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
      const mapped = mapLegacyGame(raw as RawLegacyGame);
      return mapped && mapped.visibility === 'PUBLIC' && !mapped.cancelled
        ? [anonymizeSnapshot(mapped)]
        : [];
    });
  }
}

export const testing = { mapLegacyGame, anonymizeSnapshot };
