import type { GamePlayerLevel } from '@phub/games';
import {
  BOOKING_PREFERENCES_CHANGED_EVENT,
  BOOKING_PREFERENCE_WEEKDAYS,
  DEFAULT_BOOKING_PREFERENCES,
  type BookingPreferences,
  type BookingPreferenceTimeWindow,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type BookingPreferencesCommandResult =
  | {
      readonly outcome: 'applied';
      readonly settings: BookingPreferences;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'version_conflict'; readonly current: BookingPreferences };

export interface BookingPreferencesRepository {
  get(tenantId: string, userId: string): Promise<BookingPreferences>;
  getPlayerLevel(tenantId: string, userId: string): Promise<GamePlayerLevel | null>;
  getRecommendationProfile(
    tenantId: string,
    userId: string,
  ): Promise<{
    readonly preferences: BookingPreferences;
    readonly playerLevel: GamePlayerLevel | null;
  }>;
  update(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly favoriteStationIds: readonly string[];
    readonly preferredTimeWindows: readonly BookingPreferenceTimeWindow[];
    readonly useHistory: boolean;
  }): Promise<BookingPreferencesCommandResult>;
}

interface PreferencesRow extends QueryResultRow {
  readonly favorite_station_ids: readonly string[];
  readonly preferred_time_windows: unknown;
  readonly use_history: boolean;
  readonly version: number;
  readonly updated_at: Date | string;
}

interface LevelRow extends QueryResultRow {
  readonly level_label: GamePlayerLevel | null;
}

interface RecommendationProfileRow extends QueryResultRow {
  readonly favorite_station_ids: readonly string[] | null;
  readonly preferred_time_windows: unknown;
  readonly use_history: boolean | null;
  readonly version: number | null;
  readonly updated_at: Date | string | null;
  readonly level_label: GamePlayerLevel | null;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

const PREFERENCES_COLUMNS =
  'favorite_station_ids, preferred_time_windows, use_history, version, updated_at';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEVELS: readonly GamePlayerLevel[] = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'];

function parseWindows(value: unknown): readonly BookingPreferenceTimeWindow[] {
  if (!Array.isArray(value) || value.length > 14) {
    throw new Error('BOOKING_PREFERENCES_WINDOWS_INVALID');
  }
  const windows: readonly unknown[] = value;
  return windows.map((window) => {
    if (typeof window !== 'object' || window === null || Array.isArray(window)) {
      throw new Error('BOOKING_PREFERENCES_WINDOWS_INVALID');
    }
    const candidate = window as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(',') !== 'endsAt,startsAt,weekday' ||
      typeof candidate.weekday !== 'string' ||
      !BOOKING_PREFERENCE_WEEKDAYS.includes(
        candidate.weekday as (typeof BOOKING_PREFERENCE_WEEKDAYS)[number],
      ) ||
      typeof candidate.startsAt !== 'string' ||
      !TIME_PATTERN.test(candidate.startsAt) ||
      typeof candidate.endsAt !== 'string' ||
      !TIME_PATTERN.test(candidate.endsAt) ||
      candidate.startsAt >= candidate.endsAt
    ) {
      throw new Error('BOOKING_PREFERENCES_WINDOWS_INVALID');
    }
    return {
      weekday: candidate.weekday as BookingPreferenceTimeWindow['weekday'],
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
    };
  });
}

function parseFavoriteStationIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('BOOKING_PREFERENCES_STATIONS_INVALID');
  }
  const stationIds: readonly unknown[] = value;
  if (
    stationIds.length > 3 ||
    !stationIds.every((item) => typeof item === 'string' && UUID_PATTERN.test(item))
  ) {
    throw new Error('BOOKING_PREFERENCES_STATIONS_INVALID');
  }
  const normalized = stationIds as readonly string[];
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('BOOKING_PREFERENCES_STATIONS_INVALID');
  }
  return normalized;
}

function mapRow(row: PreferencesRow): BookingPreferences {
  return {
    favoriteStationIds: parseFavoriteStationIds(row.favorite_station_ids),
    preferredTimeWindows: parseWindows(row.preferred_time_windows),
    useHistory: row.use_history,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function parseStoredSettings(value: unknown): BookingPreferences {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('favoriteStationIds' in value) ||
    !('preferredTimeWindows' in value) ||
    !('useHistory' in value) ||
    typeof value.useHistory !== 'boolean' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 0 ||
    !('updatedAt' in value) ||
    (value.updatedAt !== null && typeof value.updatedAt !== 'string')
  ) {
    throw new Error('BOOKING_PREFERENCES_COMMAND_RESULT_INVALID');
  }
  return {
    favoriteStationIds: parseFavoriteStationIds(value.favoriteStationIds),
    preferredTimeWindows: parseWindows(value.preferredTimeWindows),
    useHistory: value.useHistory,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

async function currentCommand(
  client: PoolClient,
  input: { readonly tenantId: string; readonly userId: string; readonly idempotencyKey: string },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select request_hash, result_payload
       from profile.booking_preference_commands
      where tenant_id = $1 and user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.userId, input.idempotencyKey],
  );
}

function replayCommand(
  command: CommandRow | undefined,
  requestHash: string,
): BookingPreferencesCommandResult | undefined {
  if (!command) return undefined;
  if (command.request_hash !== requestHash) return { outcome: 'idempotency_conflict' };
  return {
    outcome: 'applied',
    settings: parseStoredSettings(command.result_payload),
    replayed: true,
  };
}

async function currentSettings(
  client: PoolClient,
  tenantId: string,
  userId: string,
  lock = false,
): Promise<BookingPreferences> {
  const row = await queryOne<PreferencesRow>(
    client,
    `select ${PREFERENCES_COLUMNS}
       from profile.booking_preferences
      where tenant_id = $1 and user_id = $2${lock ? ' for update' : ''}`,
    [tenantId, userId],
  );
  return row ? mapRow(row) : { ...DEFAULT_BOOKING_PREFERENCES };
}

async function recordChange(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly previous: BookingPreferences;
    readonly settings: BookingPreferences;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, 'BOOKING_PREFERENCES_UPDATED', 'BOOKING_PREFERENCES', $3,
               'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.userId,
      input.correlationId,
      JSON.stringify(input.previous),
      JSON.stringify(input.settings),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      BOOKING_PREFERENCES_CHANGED_EVENT,
      input.userId,
      input.correlationId,
      JSON.stringify({
        userId: input.userId,
        version: input.settings.version,
        favoriteStationIds: input.settings.favoriteStationIds,
        preferredTimeWindows: input.settings.preferredTimeWindows,
        useHistory: input.settings.useHistory,
      }),
    ],
  );
}

export function createBookingPreferencesRepository(pool: Pool): BookingPreferencesRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, (client) =>
        currentSettings(client, tenantId, userId),
      );
    },

    getPlayerLevel(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<LevelRow>(
          client,
          `select level_label
             from profile.user_summaries
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row?.level_label && LEVELS.includes(row.level_label) ? row.level_label : null;
      });
    },

    getRecommendationProfile(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<RecommendationProfileRow>(
          client,
          `select p.favorite_station_ids, p.preferred_time_windows, p.use_history,
                  p.version, p.updated_at, s.level_label
             from identity.users u
             left join profile.booking_preferences p
               on p.tenant_id = u.tenant_id and p.user_id = u.id
             left join profile.user_summaries s
               on s.tenant_id = u.tenant_id and s.user_id = u.id
            where u.tenant_id = $1 and u.id = $2`,
          [tenantId, userId],
        );
        if (!row) throw new Error('BOOKING_RECOMMENDATION_PROFILE_NOT_FOUND');
        const preferences =
          row.version === null ||
          row.updated_at === null ||
          row.favorite_station_ids === null ||
          row.use_history === null
            ? { ...DEFAULT_BOOKING_PREFERENCES }
            : mapRow({
                favorite_station_ids: row.favorite_station_ids,
                preferred_time_windows: row.preferred_time_windows,
                use_history: row.use_history,
                version: row.version,
                updated_at: row.updated_at,
              });
        return {
          preferences,
          playerLevel: row.level_label && LEVELS.includes(row.level_label) ? row.level_label : null,
        };
      });
    },

    update(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `booking-preferences:${input.tenantId}:${input.userId}`,
        ]);
        const replay = replayCommand(await currentCommand(client, input), input.requestHash);
        if (replay) return replay;

        const previous = await currentSettings(client, input.tenantId, input.userId, true);
        if (previous.version !== input.expectedVersion) {
          return { outcome: 'version_conflict', current: previous };
        }

        const row = await queryOne<PreferencesRow>(
          client,
          `insert into profile.booking_preferences (
             tenant_id, user_id, favorite_station_ids, preferred_time_windows,
             use_history, version, updated_by
           ) values ($1, $2, $3::uuid[], $4::jsonb, $5, 1, $6)
           on conflict (tenant_id, user_id) do update set
             favorite_station_ids = excluded.favorite_station_ids,
             preferred_time_windows = excluded.preferred_time_windows,
             use_history = excluded.use_history,
             version = profile.booking_preferences.version + 1,
             updated_by = excluded.updated_by,
             updated_at = now()
           where profile.booking_preferences.version = $7
           returning ${PREFERENCES_COLUMNS}`,
          [
            input.tenantId,
            input.userId,
            input.favoriteStationIds,
            JSON.stringify(input.preferredTimeWindows),
            input.useHistory,
            input.actorUserId,
            input.expectedVersion,
          ],
        );
        if (!row) {
          return {
            outcome: 'version_conflict',
            current: await currentSettings(client, input.tenantId, input.userId, true),
          };
        }
        const settings = mapRow(row);
        await client.query(
          `insert into profile.booking_preference_commands (
             tenant_id, user_id, idempotency_key, request_hash, expected_version, result_payload
           ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.idempotencyKey,
            input.requestHash,
            input.expectedVersion,
            JSON.stringify(settings),
          ],
        );
        await recordChange(client, { ...input, previous, settings });
        return { outcome: 'applied', settings, replayed: false };
      });
    },
  };
}
