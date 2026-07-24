import { createHash } from 'node:crypto';

import type { GameKind, GamePaymentState, GamePlayerLevel, GameVisibility } from '@phub/games';
import { MongoClient, type Document, type Filter } from 'mongodb';

export interface LegacyGameSourceParticipant {
  readonly externalId: string;
  readonly displayName: string;
  readonly level: GamePlayerLevel | null;
  readonly levelValue: number | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly paymentState: Extract<GamePaymentState, 'NOT_REQUIRED' | 'PAID'>;
  /** Integration-only source. The worker must copy it to a PadlHub-owned WebP before projection. */
  readonly avatarSourceUrl: string | null;
}

export interface LegacyGameSourceSnapshot {
  readonly externalId: string;
  readonly externalVersion: string;
  /** Server-side integration key only; never serialized into a game DTO. */
  readonly vivaExerciseExternalId: string | null;
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
  /** One-way player key proven by the server-side viewer-phone lookup, when present. */
  readonly viewerParticipantExternalId?: string | null;
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
  readonly photo?: unknown;
  readonly phone?: unknown;
  readonly phoneNorm?: unknown;
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
    readonly vivaExerciseId?: unknown;
  };
  readonly booking?: {
    readonly [key: string]: unknown;
    readonly studioId?: unknown;
    readonly studioName?: unknown;
    readonly roomId?: unknown;
    readonly roomName?: unknown;
    readonly timeFromIso?: unknown;
    readonly timeToIso?: unknown;
    readonly vivaExerciseId?: unknown;
  };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function phoneDigits(value: unknown): string | undefined {
  const digits = stringValue(value)?.replace(/\D/g, '');
  return digits && /^\d{10,15}$/.test(digits) ? digits : undefined;
}

function uuidValue(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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

function playerLevelValue(value: unknown): number | null {
  const rating = numericValue(value);
  return rating !== undefined && rating >= 0 && rating <= 10 ? rating : null;
}

function pseudonymousId(entityType: string, externalId: string): string {
  return createHash('sha256')
    .update(`phub-local-public-clone-v1:${entityType}:${externalId}`)
    .digest('hex');
}

/**
 * Produces the same one-way local association key used by the public legacy clone. The raw Viva
 * exercise UUID is used only in memory while matching the two server-side sources and is never
 * persisted by the local bridge.
 */
export function localVivaExerciseAssociationId(externalId: string): string {
  const normalized = uuidValue(externalId);
  if (!normalized) throw new Error('VIVA_EXERCISE_ID_INVALID');
  return pseudonymousId('viva-exercise', normalized);
}

/** Matches a Viva profile to the anonymized local player key without persisting the raw UUID. */
export function localVivaProfileAssociationId(externalId: string): string {
  const normalized = stringValue(externalId);
  if (!normalized) throw new Error('VIVA_PROFILE_ID_INVALID');
  return pseudonymousId('player', normalized);
}

function sanitizeSnapshot(snapshot: LegacyGameSourceSnapshot): LegacyGameSourceSnapshot {
  const participants = snapshot.participants.map((item) => ({
    ...item,
    externalId: localVivaProfileAssociationId(item.externalId),
  }));
  return {
    ...snapshot,
    externalId: pseudonymousId('game', snapshot.externalId),
    vivaExerciseExternalId: snapshot.vivaExerciseExternalId
      ? localVivaExerciseAssociationId(snapshot.vivaExerciseExternalId)
      : null,
    // A public game's title is presentation data, not an integration identifier. Preserve it so
    // Home renders the name the organizer gave the game while IDs remain pseudonymous.
    title: snapshot.title,
    station: {
      ...snapshot.station,
      externalId: pseudonymousId('station', snapshot.station.externalId),
      courtExternalId: snapshot.station.courtExternalId
        ? pseudonymousId('court', snapshot.station.courtExternalId)
        : null,
    },
    organizerExternalId: localVivaProfileAssociationId(snapshot.organizerExternalId),
    viewerParticipantExternalId: snapshot.viewerParticipantExternalId
      ? localVivaProfileAssociationId(snapshot.viewerParticipantExternalId)
      : null,
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
  const rating = raw.ratingNumeric ?? raw.rating;
  return {
    externalId,
    displayName,
    level: playerLevel(rating),
    levelValue: playerLevelValue(rating),
    role: externalId === organizerExternalId ? 'ORGANIZER' : 'PLAYER',
    paymentState: 'PAID',
    avatarSourceUrl: httpsUrl(raw.photo) ?? null,
  };
}

function mapLegacyGame(
  raw: RawLegacyGame,
  viewerPhoneE164?: string,
): LegacyGameSourceSnapshot | undefined {
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
    levelValue: playerLevelValue(raw.organizer?.ratingNumeric ?? raw.organizer?.rating),
    role: 'ORGANIZER' as const,
    paymentState: 'PAID' as const,
    avatarSourceUrl: httpsUrl(raw.organizer?.photo) ?? null,
  };
  const participantMap = new Map<string, LegacyGameSourceParticipant>([
    [organizerExternalId, organizer],
  ]);
  for (const item of raw.participants ?? []) {
    const normalized = participant(item, organizerExternalId);
    if (normalized) {
      const existing = participantMap.get(normalized.externalId);
      participantMap.set(normalized.externalId, {
        ...existing,
        ...normalized,
        avatarSourceUrl: normalized.avatarSourceUrl ?? existing?.avatarSourceUrl ?? null,
      });
    }
  }
  const format = stringValue(raw.metadata?.gameFormat);
  const capacity: 2 | 4 = format === 'singles' ? 2 : 4;
  const participants = [...participantMap.values()].slice(0, capacity);
  const viewerPhone = phoneDigits(viewerPhoneE164);
  const viewerParticipantExternalId = viewerPhone
    ? [raw.organizer, ...(raw.participants ?? [])].find(
        (item) =>
          phoneDigits(item?.phoneNorm ?? item?.phone) === viewerPhone &&
          stringValue(item?.id) !== undefined,
      )?.id
    : undefined;
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
  const vivaExerciseExternalId =
    uuidValue(raw.metadata?.vivaExerciseId) ?? uuidValue(raw.booking?.vivaExerciseId) ?? null;
  const externalVersion = createHash('sha256')
    .update(
      JSON.stringify({
        snapshotContractVersion: 2,
        updatedAt,
        legacyStatus,
        title,
        ratingGame,
        visibility,
        startsAt,
        endsAt,
        station,
        vivaExerciseExternalId,
        capacity,
        paymentMode,
        minRating,
        maxRating,
        participants: participants.map((item) => ({
          externalId: item.externalId,
          displayName: item.displayName,
          level: item.level,
          levelValue: item.levelValue,
          role: item.role,
          paymentState: item.paymentState,
        })),
      }),
    )
    .digest('hex');

  return {
    externalId,
    externalVersion,
    vivaExerciseExternalId,
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
    viewerParticipantExternalId: stringValue(viewerParticipantExternalId) ?? null,
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

    return this.readMatching({
      filter: {
        archived: { $ne: true },
        status: { $in: ['PAID', 'CANCELLED'] },
        'booking.timeFromIso': { $gte: from, $lt: to },
      },
      limit: input.limit,
      sort: { 'booking.timeFromIso': 1, _id: 1 },
    });
  }

  /**
   * Resolves only the current LK games that are explicitly associated with Viva exercises from
   * the server-side Home snapshot. This is intentionally not available to browser callers.
   */
  public async readByVivaExerciseIds(input: {
    readonly exerciseExternalIds: readonly string[];
    readonly limit: number;
    readonly viewerPhoneE164?: string;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
    const exerciseExternalIds = [...new Set(input.exerciseExternalIds.map((id) => id.trim()))]
      .filter((id) => uuidValue(id))
      .slice(0, 100);
    if (exerciseExternalIds.length === 0) return [];
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('LEGACY_GAMES_LIMIT_INVALID');
    }

    const snapshots = await this.readMatching({
      filter: {
        archived: { $ne: true },
        status: { $in: ['PAID', 'CANCELLED'] },
        $or: [
          { 'metadata.vivaExerciseId': { $in: exerciseExternalIds } },
          { 'booking.vivaExerciseId': { $in: exerciseExternalIds } },
        ],
      },
      limit: input.limit,
      sort: { updatedAt: -1, _id: 1 },
    });
    const requested = new Set(exerciseExternalIds);
    return snapshots.filter(
      (snapshot) =>
        snapshot.vivaExerciseExternalId !== null && requested.has(snapshot.vivaExerciseExternalId),
    );
  }

  private async readMatching(input: {
    readonly filter: Filter<RawLegacyGame>;
    readonly limit: number;
    readonly sort: Document;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
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
        const rows = await client
          .db(this.options.dbName ?? 'games')
          .collection<RawLegacyGame>(this.options.collectionName ?? 'lk_games')
          .find(input.filter, {
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
              'metadata.vivaExerciseId': 1,
              'booking.studioId': 1,
              'booking.studioName': 1,
              'booking.roomId': 1,
              'booking.roomName': 1,
              'booking.timeFromIso': 1,
              'booking.timeToIso': 1,
              'booking.vivaExerciseId': 1,
            },
            maxTimeMS: this.options.timeoutMs ?? 5_000,
          })
          .sort(input.sort)
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

  private async readMappedPage(
    url: URL,
    viewerPhoneE164?: string,
  ): Promise<{
    readonly snapshots: readonly LegacyGameSourceSnapshot[];
    readonly rawCount: number;
    readonly total?: number;
    readonly hasMore?: boolean;
  }> {
    const baseUrl = new URL(this.options.baseUrl ?? 'https://padlhub.su');
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
      throw new Error('LEGACY_GAMES_PUBLIC_BASE_URL_INVALID');
    }
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
    const record = body as { readonly total?: unknown; readonly hasMore?: unknown };
    const total =
      typeof record.total === 'number' && Number.isInteger(record.total) && record.total >= 0
        ? record.total
        : undefined;
    const hasMore = typeof record.hasMore === 'boolean' ? record.hasMore : undefined;
    return {
      snapshots: games.flatMap((raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
        const mapped = mapLegacyGame(raw as RawLegacyGame, viewerPhoneE164);
        return mapped ? [mapped] : [];
      }),
      rawCount: games.length,
      ...(total === undefined ? {} : { total }),
      ...(hasMore === undefined ? {} : { hasMore }),
    };
  }

  private async readMapped(url: URL): Promise<readonly LegacyGameSourceSnapshot[]> {
    return (await this.readMappedPage(url)).snapshots;
  }

  private async readMappedAvailable(limit: number): Promise<readonly LegacyGameSourceSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('LEGACY_GAMES_LIMIT_INVALID');
    }
    const baseUrl = new URL(this.options.baseUrl ?? 'https://padlhub.su');
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
      throw new Error('LEGACY_GAMES_PUBLIC_BASE_URL_INVALID');
    }
    const url = new URL('/lk/games', baseUrl);
    url.searchParams.set('public', 'true');
    url.searchParams.set('available', 'true');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', '0');
    return (await this.readMapped(url)).filter(
      (snapshot) => snapshot.visibility === 'PUBLIC' && !snapshot.cancelled,
    );
  }

  public async readAvailable(input: {
    readonly limit: number;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
    return (await this.readMappedAvailable(input.limit)).map(sanitizeSnapshot);
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
    return (await this.readMappedAvailable(input.limit))
      .filter(
        (snapshot) =>
          Date.parse(snapshot.startsAt) >= Date.parse(from) &&
          Date.parse(snapshot.startsAt) < Date.parse(to),
      )
      .map(sanitizeSnapshot);
  }

  /**
   * Local-only counterpart of the Mongo bridge. Viva first proves the exercise UUID for the
   * authenticated viewer; the server reads that viewer's CUP history and keeps only the matching
   * historical/private games. Raw identifiers and the lookup phone never cross the API boundary or
   * enter local business tables.
   */
  public async readByVivaExerciseIds(input: {
    readonly exerciseExternalIds: readonly string[];
    readonly limit: number;
    readonly viewerPhoneE164?: string;
  }): Promise<readonly LegacyGameSourceSnapshot[]> {
    const exerciseExternalIds = [...new Set(input.exerciseExternalIds.map((id) => id.trim()))]
      .filter((id) => uuidValue(id))
      .slice(0, 100);
    if (exerciseExternalIds.length === 0) return [];
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('LEGACY_GAMES_LIMIT_INVALID');
    }
    const requested = new Set(exerciseExternalIds);
    const phone = input.viewerPhoneE164?.replace(/\D/g, '');
    if (phone && /^\d{10,15}$/.test(phone)) {
      const baseUrl = new URL(this.options.baseUrl ?? 'https://padlhub.su');
      if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
        throw new Error('LEGACY_GAMES_PUBLIC_BASE_URL_INVALID');
      }
      const matches: LegacyGameSourceSnapshot[] = [];
      const pageSize = 500;
      for (let pageIndex = 0; pageIndex < 20 && matches.length < input.limit; pageIndex += 1) {
        const offset = pageIndex * pageSize;
        const url = new URL('/lk/games/by-phone', baseUrl);
        url.searchParams.set('phone', phone);
        url.searchParams.set('includePast', 'true');
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const page = await this.readMappedPage(url, input.viewerPhoneE164);
        matches.push(
          ...page.snapshots.filter(
            (snapshot) =>
              snapshot.vivaExerciseExternalId !== null &&
              requested.has(snapshot.vivaExerciseExternalId),
          ),
        );
        const hasMore =
          page.hasMore ??
          (page.total === undefined
            ? page.rawCount === pageSize
            : offset + page.rawCount < page.total);
        if (!hasMore) break;
      }
      return matches.slice(0, input.limit).map(sanitizeSnapshot);
    } else {
      // Home has no reason to pass the viewer phone. Its upcoming bridge stays on the bounded
      // public-available projection and still filters by the Viva-proven exercise IDs in memory.
      const candidates = await this.readMappedAvailable(500);
      const matches = candidates.filter(
        (snapshot) =>
          snapshot.vivaExerciseExternalId !== null &&
          requested.has(snapshot.vivaExerciseExternalId),
      );
      return matches.slice(0, input.limit).map(sanitizeSnapshot);
    }
  }
}

export const testing = { mapLegacyGame, sanitizeSnapshot };
