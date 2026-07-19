import { randomUUID } from 'node:crypto';

import {
  gameDomainEventSchema,
  type GameKind,
  type GameLifecycleState,
  type GamePlayerLevel,
  type GameVisibility,
} from '@phub/games';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

const EXTERNAL_SYSTEM = 'LK_LEGACY_SNAPSHOT';
const VIVA_EXTERNAL_SYSTEM = 'VIVA';

export interface LegacyGameImportParticipant {
  readonly externalId: string;
  readonly displayName: string;
  readonly level: GamePlayerLevel | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly paymentState: 'NOT_REQUIRED' | 'PAID';
}

export interface LegacyGameImportSnapshot {
  readonly externalId: string;
  readonly externalVersion: string;
  /** Integration-only VIVA exercise key. It must never reach a Games or Home DTO. */
  readonly vivaExerciseExternalId: string | null;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly cancelled: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly station: {
    readonly externalId: string;
    readonly name: string;
    readonly courtExternalId: string | null;
    readonly courtName: string | null;
  };
  readonly capacity: number;
  readonly waitlistEnabled: boolean;
  readonly paymentMode: 'ORGANIZER_PAYS' | 'SPLIT';
  readonly levelFrom: GamePlayerLevel | null;
  readonly levelTo: GamePlayerLevel | null;
  readonly organizerExternalId: string;
  readonly participants: readonly LegacyGameImportParticipant[];
}

export interface LegacyGameImportResult {
  readonly tenantId: string;
  readonly imported: readonly { readonly gameId: string; readonly projectionEventId: string }[];
  readonly existing: readonly { readonly gameId: string; readonly projectionEventId: string }[];
  readonly skipped: number;
}

export interface LegacyGameParticipantSyncResult {
  readonly tenantId: string;
  readonly synced: readonly { readonly gameId: string; readonly projectionEventId: string }[];
  readonly bootstrapped: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly skipped: number;
}

export interface LegacyGameImportRepository {
  importSnapshots(input: {
    readonly tenantKey: string;
    readonly snapshots: readonly LegacyGameImportSnapshot[];
    readonly correlationId: string;
    readonly now?: Date;
  }): Promise<LegacyGameImportResult>;
  /**
   * Mirrors an imported roster only while its canonical aggregate still has the revision that
   * the previous mirror run wrote. A local command therefore produces a durable conflict instead
   * of being overwritten by the old LK source.
   */
  synchronizeParticipants(input: {
    readonly tenantKey: string;
    readonly snapshots: readonly LegacyGameImportSnapshot[];
    readonly correlationId: string;
    readonly now?: Date;
  }): Promise<LegacyGameParticipantSyncResult>;
}

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface MappingRow extends QueryResultRow {
  readonly internal_id: string;
  readonly external_version?: string | null;
}

interface LegacyGameRow extends QueryResultRow {
  readonly id: string;
  readonly revision: string | number;
  readonly organizer_user_id: string;
  readonly lifecycle_state: GameLifecycleState;
}

interface ActiveParticipantRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly payment_state: 'NOT_REQUIRED' | 'PAID';
  readonly external_id: string | null;
}

interface RosterSyncStateRow extends QueryResultRow {
  readonly source_external_version: string;
  readonly last_synced_game_revision: string | number;
  readonly mode: 'MIRROR' | 'CONFLICT' | 'DISABLED';
}

function cleanText(value: string, maxLength: number, fallback: string): string {
  const clean = value.trim().replace(/\s+/g, ' ');
  return (clean || fallback).slice(0, maxLength);
}

function lifecycle(snapshot: LegacyGameImportSnapshot, now: Date): GameLifecycleState {
  if (snapshot.cancelled) return 'CANCELLED';
  if (Date.parse(snapshot.endsAt) <= now.getTime()) return 'FINISHED';
  if (Date.parse(snapshot.startsAt) <= now.getTime()) return 'IN_PROGRESS';
  return 'SCHEDULED';
}

function createdAt(snapshot: LegacyGameImportSnapshot, now: Date): string {
  return new Date(
    Math.min(now.getTime(), Date.parse(snapshot.startsAt) - 86_400_000),
  ).toISOString();
}

async function findMapping(
  client: PoolClient,
  tenantId: string,
  entityType: 'game' | 'game_player' | 'game_station' | 'game_court',
  externalId: string,
): Promise<string | undefined> {
  const row = await queryOne<MappingRow>(
    client,
    `select internal_id
       from integration.external_entity_map
      where tenant_id = $1 and external_system = $2 and entity_type = $3 and external_id = $4`,
    [tenantId, EXTERNAL_SYSTEM, entityType, externalId],
  );
  return row?.internal_id;
}

async function insertMapping(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly entityType: 'game' | 'game_player' | 'game_station' | 'game_court';
    readonly internalId: string;
    readonly externalId: string;
    readonly externalVersion: string;
  },
): Promise<void> {
  await client.query(
    `insert into integration.external_entity_map (
       tenant_id, external_system, entity_type, internal_id, external_id,
       external_version, last_synced_at, sync_status, sync_error_code
     ) values ($1, $2, $3, $4, $5, $6, now(), 'synced', null)`,
    [
      input.tenantId,
      EXTERNAL_SYSTEM,
      input.entityType,
      input.internalId,
      input.externalId,
      input.externalVersion,
    ],
  );
}

async function associateVivaExercise(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly vivaExerciseExternalId: string | null;
    readonly externalVersion: string;
  },
): Promise<void> {
  if (!input.vivaExerciseExternalId) return;
  const existing = await queryOne<MappingRow>(
    client,
    `select internal_id
       from integration.external_entity_map
      where tenant_id = $1 and external_system = $2 and entity_type = 'exercise' and external_id = $3
      for update`,
    [input.tenantId, VIVA_EXTERNAL_SYSTEM, input.vivaExerciseExternalId],
  );
  if (existing && existing.internal_id !== input.gameId) {
    throw new Error('VIVA_EXERCISE_GAME_ASSOCIATION_CONFLICT');
  }
  if (existing) {
    await client.query(
      `update integration.external_entity_map
          set external_version = $4, last_synced_at = now(), sync_status = 'synced',
              sync_error_code = null
        where tenant_id = $1 and external_system = $2 and entity_type = 'exercise' and external_id = $3`,
      [input.tenantId, VIVA_EXTERNAL_SYSTEM, input.vivaExerciseExternalId, input.externalVersion],
    );
    return;
  }
  await client.query(
    `insert into integration.external_entity_map (
       tenant_id, external_system, entity_type, internal_id, external_id,
       external_version, last_synced_at, sync_status, sync_error_code
     ) values ($1, $2, 'exercise', $3, $4, $5, now(), 'synced', null)`,
    [
      input.tenantId,
      VIVA_EXTERNAL_SYSTEM,
      input.gameId,
      input.vivaExerciseExternalId,
      input.externalVersion,
    ],
  );
}

async function resolvePlayer(
  client: PoolClient,
  tenantId: string,
  participant: LegacyGameImportParticipant,
  externalVersion: string,
): Promise<string> {
  const existing = await findMapping(client, tenantId, 'game_player', participant.externalId);
  const userId = existing ?? randomUUID();
  if (!existing) {
    await client.query(`insert into identity.users (id, tenant_id) values ($1, $2)`, [
      userId,
      tenantId,
    ]);
    await insertMapping(client, {
      tenantId,
      entityType: 'game_player',
      internalId: userId,
      externalId: participant.externalId,
      externalVersion,
    });
  }
  await client.query(
    `insert into profile.user_summaries (tenant_id, user_id, display_name, level_label)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, user_id) do update set
       display_name = excluded.display_name,
       level_label = excluded.level_label,
       updated_at = now()`,
    [tenantId, userId, cleanText(participant.displayName, 200, 'Игрок'), participant.level],
  );
  return userId;
}

async function resolveStation(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly externalId: string;
    readonly externalVersion: string;
    readonly name: string;
    readonly actorUserId: string;
  },
): Promise<string> {
  const existing = await findMapping(client, input.tenantId, 'game_station', input.externalId);
  if (existing) return existing;
  const stationId = randomUUID();
  await client.query(
    `insert into locations.profiles (
       tenant_id, id, slug, title, short_title, timezone, publication_status,
       created_by, updated_by, published_at
     ) values ($1, $2, $3, $4, $4, 'Europe/Moscow', 'PUBLISHED', $5, $5, now())`,
    [
      input.tenantId,
      stationId,
      `legacy-${stationId.slice(0, 8)}`,
      cleanText(input.name, 80, 'Площадка'),
      input.actorUserId,
    ],
  );
  await insertMapping(client, {
    tenantId: input.tenantId,
    entityType: 'game_station',
    internalId: stationId,
    externalId: input.externalId,
    externalVersion: input.externalVersion,
  });
  return stationId;
}

async function resolveCourt(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly externalId: string | null;
    readonly externalVersion: string;
  },
): Promise<string | null> {
  if (!input.externalId) return null;
  const existing = await findMapping(client, input.tenantId, 'game_court', input.externalId);
  if (existing) return existing;
  const courtId = randomUUID();
  await insertMapping(client, {
    tenantId: input.tenantId,
    entityType: 'game_court',
    internalId: courtId,
    externalId: input.externalId,
    externalVersion: input.externalVersion,
  });
  return courtId;
}

async function importOne(
  pool: Pool,
  input: {
    readonly tenantId: string;
    readonly snapshot: LegacyGameImportSnapshot;
    readonly correlationId: string;
    readonly now: Date;
  },
): Promise<{
  readonly outcome: 'imported' | 'existing';
  readonly gameId: string;
  readonly projectionEventId: string;
}> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `legacy-game-import:${input.tenantId}`,
    ]);
    const existingGameId = await findMapping(
      client,
      input.tenantId,
      'game',
      input.snapshot.externalId,
    );
    if (existingGameId) {
      await associateVivaExercise(client, {
        tenantId: input.tenantId,
        gameId: existingGameId,
        vivaExerciseExternalId: input.snapshot.vivaExerciseExternalId,
        externalVersion: input.snapshot.externalVersion,
      });
      return { outcome: 'existing', gameId: existingGameId, projectionEventId: randomUUID() };
    }

    const participantIds = new Map<string, string>();
    for (const participant of input.snapshot.participants) {
      participantIds.set(
        participant.externalId,
        await resolvePlayer(client, input.tenantId, participant, input.snapshot.externalVersion),
      );
    }
    const organizerUserId = participantIds.get(input.snapshot.organizerExternalId);
    if (!organizerUserId) throw new Error('LEGACY_GAME_ORGANIZER_MAPPING_MISSING');

    const stationId = await resolveStation(client, {
      tenantId: input.tenantId,
      externalId: input.snapshot.station.externalId,
      externalVersion: input.snapshot.externalVersion,
      name: input.snapshot.station.name,
      actorUserId: organizerUserId,
    });
    const courtId = await resolveCourt(client, {
      tenantId: input.tenantId,
      externalId: input.snapshot.station.courtExternalId,
      externalVersion: input.snapshot.externalVersion,
    });
    const gameId = randomUUID();
    const state = lifecycle(input.snapshot, input.now);
    const initialCreatedAt = createdAt(input.snapshot, input.now);
    await client.query(
      `insert into games.games (
         tenant_id, id, revision, organizer_user_id, title, kind, visibility,
         lifecycle_state, station_id, court_id, starts_at, ends_at, timezone,
         capacity, waitlist_enabled, payment_mode, level_from, level_to, result_state,
         cancellation_reason_code, cancelled_at, started_at, finished_at, created_at, updated_at
       ) values (
         $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23
       )`,
      [
        input.tenantId,
        gameId,
        organizerUserId,
        cleanText(input.snapshot.title, 160, 'Игра'),
        input.snapshot.kind,
        input.snapshot.visibility,
        state,
        stationId,
        courtId,
        input.snapshot.startsAt,
        input.snapshot.endsAt,
        input.snapshot.timezone,
        input.snapshot.capacity,
        input.snapshot.waitlistEnabled,
        input.snapshot.paymentMode,
        input.snapshot.levelFrom,
        input.snapshot.levelTo,
        state === 'FINISHED'
          ? 'AWAITING_SUBMISSION'
          : state === 'CANCELLED'
            ? 'VOID'
            : 'NOT_AVAILABLE',
        state === 'CANCELLED' ? 'OTHER' : null,
        state === 'CANCELLED' ? input.now.toISOString() : null,
        state === 'IN_PROGRESS' || state === 'FINISHED' ? input.snapshot.startsAt : null,
        state === 'FINISHED' ? input.snapshot.endsAt : null,
        initialCreatedAt,
      ],
    );
    await insertMapping(client, {
      tenantId: input.tenantId,
      entityType: 'game',
      internalId: gameId,
      externalId: input.snapshot.externalId,
      externalVersion: input.snapshot.externalVersion,
    });
    await associateVivaExercise(client, {
      tenantId: input.tenantId,
      gameId,
      vivaExerciseExternalId: input.snapshot.vivaExerciseExternalId,
      externalVersion: input.snapshot.externalVersion,
    });

    const uniqueParticipants = input.snapshot.participants.slice(0, input.snapshot.capacity);
    for (const participant of uniqueParticipants) {
      const userId = participantIds.get(participant.externalId);
      if (!userId) throw new Error('LEGACY_GAME_PARTICIPANT_MAPPING_MISSING');
      await client.query(
        `insert into games.participations (
           tenant_id, game_id, user_id, role, state, payment_state, joined_at, updated_at
         ) values ($1, $2, $3, $4, 'ACTIVE', $5, $6, $6)`,
        [
          input.tenantId,
          gameId,
          userId,
          participant.externalId === input.snapshot.organizerExternalId ? 'ORGANIZER' : 'PLAYER',
          participant.paymentState,
          initialCreatedAt,
        ],
      );
    }

    const projectionEventId = randomUUID();
    const occurredAt = input.now.toISOString();
    const participantUserIds = uniqueParticipants
      .map((participant) => participantIds.get(participant.externalId))
      .filter((id): id is string => Boolean(id));
    const eventType =
      state === 'CANCELLED'
        ? 'game.cancelled.v1'
        : state === 'FINISHED'
          ? 'game.finished.v1'
          : state === 'IN_PROGRESS'
            ? 'game.started.v1'
            : 'game.scheduled.v1';
    const commonPayload = {
      gameId,
      aggregateRevision: '1',
      causationId: projectionEventId,
      actorUserId: null,
    };
    const payload =
      eventType === 'game.scheduled.v1'
        ? { ...commonPayload, organizerUserId }
        : eventType === 'game.cancelled.v1'
          ? { ...commonPayload, participantUserIds, reasonCode: 'OTHER' as const }
          : { ...commonPayload, participantUserIds };
    const event = gameDomainEventSchema.parse({
      id: projectionEventId,
      type: eventType,
      aggregateId: gameId,
      tenantId: input.tenantId,
      occurredAt,
      correlationId: input.correlationId,
      payload,
    });
    await client.query(
      `insert into audit.outbox_events (
         id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        event.id,
        event.tenantId,
        event.type,
        event.aggregateId,
        event.correlationId,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id, result,
         reason, correlation_id, new_value
       ) values ($1, null, 'GAME_IMPORTED_FROM_LEGACY_SNAPSHOT', 'GAME', $2,
                 'SUCCESS', 'READ_ONLY_LOCAL_CLONE', $3, $4::jsonb)`,
      [
        input.tenantId,
        gameId,
        input.correlationId,
        JSON.stringify({
          revision: 1,
          lifecycleState: state,
          visibility: input.snapshot.visibility,
          participantCount: uniqueParticipants.length,
        }),
      ],
    );
    return { outcome: 'imported', gameId, projectionEventId };
  });
}

function participantFingerprint(input: {
  readonly externalId: string;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly paymentState: 'NOT_REQUIRED' | 'PAID';
}): string {
  return `${input.externalId}\u0000${input.role}\u0000${input.paymentState}`;
}

function sameRoster(
  current: readonly ActiveParticipantRow[],
  snapshot: LegacyGameImportSnapshot,
): boolean {
  if (current.some((item) => !item.external_id)) return false;
  const currentRoster = current
    .map((item) =>
      participantFingerprint({
        externalId: item.external_id as string,
        role: item.role,
        paymentState: item.payment_state,
      }),
    )
    .sort();
  const sourceRoster = snapshot.participants
    .map((item) =>
      participantFingerprint({
        externalId: item.externalId,
        role: item.externalId === snapshot.organizerExternalId ? 'ORGANIZER' : 'PLAYER',
        paymentState: item.paymentState,
      }),
    )
    .sort();
  return (
    currentRoster.length === sourceRoster.length &&
    currentRoster.every((item, i) => item === sourceRoster[i])
  );
}

async function recordRosterConflict(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly sourceExternalVersion: string;
    readonly currentRevision: number;
    readonly code:
      'LEGACY_GAME_ROSTER_BASELINE_MISMATCH' | 'LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED';
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `insert into integration.legacy_game_roster_sync_state (
       tenant_id, game_id, source_external_version, last_synced_game_revision,
       mode, conflict_code, last_synced_at, updated_at
     ) values ($1, $2, $3, $4, 'CONFLICT', $5, now(), now())
     on conflict (tenant_id, game_id) do update set
       mode = 'CONFLICT', conflict_code = excluded.conflict_code,
       source_external_version = excluded.source_external_version,
       updated_at = now()`,
    [input.tenantId, input.gameId, input.sourceExternalVersion, input.currentRevision, input.code],
  );
  await client.query(
    `update integration.external_entity_map
        set sync_status = 'conflict', sync_error_code = $4, last_synced_at = now()
      where tenant_id = $1 and external_system = $2 and entity_type = 'game' and internal_id = $3`,
    [input.tenantId, EXTERNAL_SYSTEM, input.gameId, input.code],
  );
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id,
       new_value
     ) values ($1, null, 'LEGACY_GAME_ROSTER_SYNC_QUARANTINED', 'GAME', $2,
               'CONFLICT', $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.gameId,
      input.code,
      input.correlationId,
      JSON.stringify({ currentRevision: input.currentRevision }),
    ],
  );
}

async function synchronizeOne(
  pool: Pool,
  input: {
    readonly tenantId: string;
    readonly snapshot: LegacyGameImportSnapshot;
    readonly correlationId: string;
    readonly now: Date;
  },
): Promise<
  | { readonly outcome: 'synced'; readonly gameId: string; readonly projectionEventId: string }
  | { readonly outcome: 'bootstrapped' | 'unchanged' | 'conflict' | 'skipped' }
> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const mapping = await queryOne<MappingRow>(
      client,
      `select internal_id, external_version
         from integration.external_entity_map
        where tenant_id = $1 and external_system = $2 and entity_type = 'game' and external_id = $3
        for update`,
      [input.tenantId, EXTERNAL_SYSTEM, input.snapshot.externalId],
    );
    if (!mapping) return { outcome: 'skipped' };
    const game = await queryOne<LegacyGameRow>(
      client,
      `select id, revision, organizer_user_id, lifecycle_state
         from games.games where tenant_id = $1 and id = $2 for update`,
      [input.tenantId, mapping.internal_id],
    );
    if (!game || game.lifecycle_state !== 'SCHEDULED') return { outcome: 'skipped' };
    const currentRevision = Number(game.revision);
    const currentParticipants = await client.query<ActiveParticipantRow>(
      `select p.id, p.user_id, p.role, p.payment_state, player.external_id
         from games.participations p
         left join integration.external_entity_map player
           on player.tenant_id = p.tenant_id and player.external_system = $3
          and player.entity_type = 'game_player' and player.internal_id = p.user_id
        where p.tenant_id = $1 and p.game_id = $2 and p.state = 'ACTIVE'
        order by p.joined_at, p.id
        for update of p`,
      [input.tenantId, game.id, EXTERNAL_SYSTEM],
    );
    const state = await queryOne<RosterSyncStateRow>(
      client,
      `select source_external_version, last_synced_game_revision, mode
         from integration.legacy_game_roster_sync_state
        where tenant_id = $1 and game_id = $2 for update`,
      [input.tenantId, game.id],
    );
    if (!state) {
      // Never take ownership of an old imported game whose source has already drifted: an
      // operator must reconcile it explicitly. Fresh imports have matching fingerprints.
      if (
        mapping.external_version !== input.snapshot.externalVersion ||
        !sameRoster(currentParticipants.rows, input.snapshot)
      ) {
        await recordRosterConflict(client, {
          tenantId: input.tenantId,
          gameId: game.id,
          sourceExternalVersion: input.snapshot.externalVersion,
          currentRevision,
          code: 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH',
          correlationId: input.correlationId,
        });
        return { outcome: 'conflict' };
      }
      await client.query(
        `insert into integration.legacy_game_roster_sync_state (
           tenant_id, game_id, source_external_version, last_synced_game_revision, mode,
           conflict_code, last_synced_at, updated_at
         ) values ($1, $2, $3, $4, 'MIRROR', null, now(), now())`,
        [input.tenantId, game.id, input.snapshot.externalVersion, currentRevision],
      );
      return { outcome: 'bootstrapped' };
    }
    if (state.mode !== 'MIRROR') return { outcome: 'conflict' };
    if (Number(state.last_synced_game_revision) !== currentRevision) {
      await recordRosterConflict(client, {
        tenantId: input.tenantId,
        gameId: game.id,
        sourceExternalVersion: input.snapshot.externalVersion,
        currentRevision,
        code: 'LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED',
        correlationId: input.correlationId,
      });
      return { outcome: 'conflict' };
    }
    if (state.source_external_version === input.snapshot.externalVersion)
      return { outcome: 'unchanged' };

    const sourceUsers = new Map<
      string,
      { userId: string; participant: LegacyGameImportParticipant }
    >();
    for (const participant of input.snapshot.participants) {
      sourceUsers.set(participant.externalId, {
        userId: await resolvePlayer(
          client,
          input.tenantId,
          participant,
          input.snapshot.externalVersion,
        ),
        participant,
      });
    }
    const organizer = sourceUsers.get(input.snapshot.organizerExternalId);
    if (!organizer) throw new Error('LEGACY_GAME_ORGANIZER_MAPPING_MISSING');
    const sourceByUserId = new Map(
      [...sourceUsers.values()].map((item) => [item.userId, item.participant]),
    );
    const activeByUserId = new Map(currentParticipants.rows.map((item) => [item.user_id, item]));
    for (const participant of currentParticipants.rows) {
      if (sourceByUserId.has(participant.user_id)) continue;
      await client.query(
        `update games.participations
            set state = 'LEFT', left_at = $4, updated_at = $4
          where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
        [input.tenantId, game.id, participant.id, input.now.toISOString()],
      );
    }
    // The partial unique organizer index requires demoting a previous organizer before a new
    // organizer can be promoted in the same mirror transaction.
    await client.query(
      `update games.participations set role = 'PLAYER', updated_at = $4
        where tenant_id = $1 and game_id = $2 and user_id <> $3
          and state = 'ACTIVE' and role = 'ORGANIZER'`,
      [input.tenantId, game.id, organizer.userId, input.now.toISOString()],
    );
    for (const { userId, participant } of sourceUsers.values()) {
      const current = activeByUserId.get(userId);
      const role: 'ORGANIZER' | 'PLAYER' =
        participant.externalId === input.snapshot.organizerExternalId ? 'ORGANIZER' : 'PLAYER';
      if (!current) {
        await client.query(
          `insert into games.participations (
             tenant_id, game_id, user_id, role, state, payment_state, joined_at, updated_at
           ) values ($1, $2, $3, $4, 'ACTIVE', $5, $6, $6)`,
          [
            input.tenantId,
            game.id,
            userId,
            role,
            participant.paymentState,
            input.now.toISOString(),
          ],
        );
      } else {
        await client.query(
          `update games.participations set role = $4, payment_state = $5, updated_at = $6
            where tenant_id = $1 and game_id = $2 and id = $3`,
          [
            input.tenantId,
            game.id,
            current.id,
            role,
            participant.paymentState,
            input.now.toISOString(),
          ],
        );
      }
    }
    const updatedGame = await queryOne<{ revision: string | number }>(
      client,
      `update games.games
          set organizer_user_id = $3, revision = revision + 1, updated_at = $4
        where tenant_id = $1 and id = $2
        returning revision`,
      [input.tenantId, game.id, organizer.userId, input.now.toISOString()],
    );
    if (!updatedGame) throw new Error('LEGACY_GAME_ROSTER_GAME_UPDATE_FAILED');
    const nextRevision = Number(updatedGame.revision);
    await client.query(
      `update integration.external_entity_map
          set external_version = $5, last_synced_at = now(), sync_status = 'synced', sync_error_code = null
        where tenant_id = $1 and external_system = $2 and entity_type = 'game' and internal_id = $3
          and external_id = $4`,
      [
        input.tenantId,
        EXTERNAL_SYSTEM,
        game.id,
        input.snapshot.externalId,
        input.snapshot.externalVersion,
      ],
    );
    await client.query(
      `update integration.legacy_game_roster_sync_state
          set source_external_version = $3, last_synced_game_revision = $4,
              last_synced_at = now(), updated_at = now()
        where tenant_id = $1 and game_id = $2 and mode = 'MIRROR'`,
      [input.tenantId, game.id, input.snapshot.externalVersion, nextRevision],
    );
    const projectionEventId = randomUUID();
    const event = gameDomainEventSchema.parse({
      id: projectionEventId,
      type: 'game.scheduled.v1',
      aggregateId: game.id,
      tenantId: input.tenantId,
      occurredAt: input.now.toISOString(),
      correlationId: input.correlationId,
      payload: {
        gameId: game.id,
        aggregateRevision: String(nextRevision),
        causationId: projectionEventId,
        actorUserId: null,
        organizerUserId: organizer.userId,
      },
    });
    await client.query(
      `insert into audit.outbox_events (
         id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        event.id,
        event.tenantId,
        event.type,
        event.aggregateId,
        event.correlationId,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id,
         old_value, new_value
       ) values ($1, null, 'GAME_PARTICIPANTS_SYNCED_FROM_LEGACY_SNAPSHOT', 'GAME', $2,
                 'SUCCESS', 'MIRROR', $3, $4::jsonb, $5::jsonb)`,
      [
        input.tenantId,
        game.id,
        input.correlationId,
        JSON.stringify({ activeParticipantCount: currentParticipants.rows.length }),
        JSON.stringify({ activeParticipantCount: sourceUsers.size, revision: nextRevision }),
      ],
    );
    return { outcome: 'synced', gameId: game.id, projectionEventId };
  });
}

export function createLegacyGameImportRepository(pool: Pool): LegacyGameImportRepository {
  return {
    async importSnapshots(input) {
      const tenant = (
        await pool.query<TenantRow>(
          `select id from identity.tenants where tenant_key = $1 and active = true`,
          [input.tenantKey],
        )
      ).rows[0];
      if (!tenant) throw new Error('LEGACY_GAME_IMPORT_TENANT_NOT_FOUND');
      if (!input.correlationId.trim() || input.correlationId.length < 8) {
        throw new Error('LEGACY_GAME_IMPORT_CORRELATION_ID_INVALID');
      }
      const imported: { gameId: string; projectionEventId: string }[] = [];
      const existing: { gameId: string; projectionEventId: string }[] = [];
      let skipped = 0;
      for (const snapshot of input.snapshots) {
        const result = await importOne(pool, {
          tenantId: tenant.id,
          snapshot,
          correlationId: input.correlationId,
          now: input.now ?? new Date(),
        });
        const target = { gameId: result.gameId, projectionEventId: result.projectionEventId };
        if (result.outcome === 'imported') imported.push(target);
        else {
          existing.push(target);
          skipped += 1;
        }
      }
      return { tenantId: tenant.id, imported, existing, skipped };
    },

    async synchronizeParticipants(input) {
      const tenant = (
        await pool.query<TenantRow>(
          `select id from identity.tenants where tenant_key = $1 and active = true`,
          [input.tenantKey],
        )
      ).rows[0];
      if (!tenant) throw new Error('LEGACY_GAME_IMPORT_TENANT_NOT_FOUND');
      if (!input.correlationId.trim() || input.correlationId.length < 8) {
        throw new Error('LEGACY_GAME_IMPORT_CORRELATION_ID_INVALID');
      }
      const synced: { gameId: string; projectionEventId: string }[] = [];
      let bootstrapped = 0;
      let unchanged = 0;
      let conflicts = 0;
      let skipped = 0;
      for (const snapshot of input.snapshots) {
        const result = await synchronizeOne(pool, {
          tenantId: tenant.id,
          snapshot,
          correlationId: input.correlationId,
          now: input.now ?? new Date(),
        });
        if (result.outcome === 'synced') synced.push(result);
        else if (result.outcome === 'bootstrapped') bootstrapped += 1;
        else if (result.outcome === 'unchanged') unchanged += 1;
        else if (result.outcome === 'conflict') conflicts += 1;
        else skipped += 1;
      }
      return { tenantId: tenant.id, synced, bootstrapped, unchanged, conflicts, skipped };
    },
  };
}
