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
  readonly levelValue: number | null;
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
  /** Server-only lookup used to bind the authenticated viewer to a sanitized CUP participant. */
  resolveVivaProfileExternalId(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<string | undefined>;
  /** Server-only lookup; used solely by the CUP history adapter and never serialized. */
  resolveViewerPhoneE164(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<string | undefined>;
  /**
   * Advances only already-associated Games aggregates selected by fresh Viva history exercise
   * references. The provider identifiers remain inside integration storage.
   */
  refreshVivaExerciseGameLifecycles(input: {
    readonly tenantId: string;
    readonly vivaExerciseAssociationIds: readonly string[];
    readonly correlationId: string;
    readonly now: Date;
  }): Promise<readonly { readonly gameId: string; readonly projectionEventId: string }[]>;
  importSnapshots(input: {
    readonly tenantKey: string;
    readonly snapshots: readonly LegacyGameImportSnapshot[];
    readonly correlationId: string;
    readonly participantUserBindings?: readonly {
      readonly externalId: string;
      readonly userId: string;
      readonly proofKind?: 'VIVA_PROFILE' | 'VIEWER_PHONE';
    }[];
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

interface AssociatedLifecycleGameRow extends QueryResultRow {
  readonly id: string;
  readonly revision: string | number;
  readonly lifecycle_state: 'SCHEDULED' | 'IN_PROGRESS';
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
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

function generatedLegacyTitle(snapshot: LegacyGameImportSnapshot): string {
  return `${snapshot.kind === 'RATING' ? 'Рейтинговая' : 'Открытая'} игра ${snapshot.capacity === 2 ? '1×1' : '2×2'}`;
}

async function reconcileLifecycleCommands(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly desiredLifecycleState: GameLifecycleState;
    readonly now: Date;
  },
): Promise<void> {
  if (input.desiredLifecycleState === 'FINISHED' || input.desiredLifecycleState === 'CANCELLED') {
    await client.query(
      `update games.scheduled_commands
          set state = 'COMPLETED', completed_at = coalesce(completed_at, $3::timestamptz),
              locked_at = null, locked_by = null
        where tenant_id = $1 and game_id = $2
          and command_type in ('game.lifecycle.start.v1', 'game.lifecycle.finish.v1')
          and state in ('PENDING', 'FAILED')`,
      [input.tenantId, input.gameId, input.now.toISOString()],
    );
    return;
  }

  if (input.desiredLifecycleState === 'IN_PROGRESS') {
    await client.query(
      `update games.scheduled_commands
          set state = 'COMPLETED', completed_at = coalesce(completed_at, $3::timestamptz),
              locked_at = null, locked_by = null
        where tenant_id = $1 and game_id = $2
          and command_type = 'game.lifecycle.start.v1'
          and state in ('PENDING', 'FAILED')`,
      [input.tenantId, input.gameId, input.now.toISOString()],
    );
  }

  // The advisory import lock serializes repeated CUP snapshots for the tenant. Keep one durable
  // start and finish command per game, and refresh a still-pending command if the aggregate
  // revision changed while the roster was being bound.
  await client.query(
    `with desired(command_type, due_at, expected_revision) as (
       select 'game.lifecycle.start.v1'::text, game.starts_at, game.revision
         from games.games game
        where game.tenant_id = $1 and game.id = $2
          and game.lifecycle_state = $3 and $3 = 'SCHEDULED'
       union all
       select 'game.lifecycle.finish.v1'::text, game.ends_at,
              game.revision + case when $3 = 'SCHEDULED' then 1 else 0 end
         from games.games game
        where game.tenant_id = $1 and game.id = $2
          and game.lifecycle_state = $3 and $3 in ('SCHEDULED', 'IN_PROGRESS')
     ), refreshed as (
       update games.scheduled_commands command set
          due_at = desired.due_at,
          expected_revision = desired.expected_revision,
          payload = jsonb_build_object(
            'gameId', command.game_id,
            'expectedRevision', desired.expected_revision::text
          ),
          available_at = case
            when command.state = 'PENDING' then least(command.available_at, desired.due_at)
            else command.available_at
          end
         from desired
        where command.tenant_id = $1 and command.game_id = $2
          and command.command_type::text = desired.command_type
          and command.state in ('PENDING', 'FAILED')
       returning command.command_type
     )
     insert into games.scheduled_commands (
       tenant_id, game_id, command_type, due_at, available_at, expected_revision, payload
     )
     select $1, $2, desired.command_type,
            desired.due_at, desired.due_at, desired.expected_revision,
            jsonb_build_object(
              'gameId', $2::uuid,
              'expectedRevision', desired.expected_revision::text
            )
       from desired
      where not exists (
        select 1
          from games.scheduled_commands command
         where command.tenant_id = $1 and command.game_id = $2
           and command.command_type::text = desired.command_type
      )`,
    [input.tenantId, input.gameId, input.desiredLifecycleState],
  );
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
  boundUserId?: string,
  proofKind: 'VIVA_PROFILE' | 'VIEWER_PHONE' = 'VIVA_PROFILE',
): Promise<string> {
  const persistedBinding = await queryOne<{ readonly user_id: string } & QueryResultRow>(
    client,
    `select user_id
       from integration.legacy_game_player_bindings
      where tenant_id = $1 and source_player_association_id = $2
      for update`,
    [tenantId, participant.externalId],
  );
  if (persistedBinding && boundUserId && persistedBinding.user_id !== boundUserId) {
    throw new Error('LEGACY_GAME_PARTICIPANT_USER_BINDING_CONFLICT');
  }
  const provenUserId = boundUserId ?? persistedBinding?.user_id;
  if (boundUserId && !persistedBinding) {
    const boundUser = await queryOne<{ readonly id: string } & QueryResultRow>(
      client,
      `select id from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'
        for share`,
      [tenantId, boundUserId],
    );
    if (!boundUser) throw new Error('LEGACY_GAME_PARTICIPANT_BOUND_USER_NOT_FOUND');
    await client.query(
      `insert into integration.legacy_game_player_bindings (
         tenant_id, source_player_association_id, user_id, proof_kind
       ) values ($1, $2, $3, $4)`,
      [tenantId, participant.externalId, boundUserId, proofKind],
    );
  }
  const existing = await findMapping(client, tenantId, 'game_player', participant.externalId);
  const userId = provenUserId ?? existing ?? randomUUID();
  if (!existing) {
    if (!provenUserId) {
      await client.query(`insert into identity.users (id, tenant_id) values ($1, $2)`, [
        userId,
        tenantId,
      ]);
    }
    await insertMapping(client, {
      tenantId,
      entityType: 'game_player',
      internalId: userId,
      externalId: participant.externalId,
      externalVersion,
    });
  }
  await client.query(
    `insert into profile.user_summaries (
       tenant_id, user_id, display_name, level_label, level_value
     ) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, user_id) do update set
       display_name = excluded.display_name,
       level_label = coalesce(excluded.level_label, profile.user_summaries.level_label),
       level_value = coalesce(excluded.level_value, profile.user_summaries.level_value),
       updated_at = now()`,
    [
      tenantId,
      userId,
      cleanText(participant.displayName, 200, 'Игрок'),
      participant.level,
      participant.levelValue,
    ],
  );
  return userId;
}

async function refreshMappedPlayerSummary(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly participant: LegacyGameImportParticipant;
  },
): Promise<void> {
  const userId = await findMapping(
    client,
    input.tenantId,
    'game_player',
    input.participant.externalId,
  );
  if (!userId) return;
  await client.query(
    `update profile.user_summaries summary
        set display_name = $3,
            level_label = coalesce($4, summary.level_label),
            level_value = coalesce($5, summary.level_value),
            updated_at = now()
      where summary.tenant_id = $1 and summary.user_id = $2
        and (
          summary.display_name = 'Организатор'
          or summary.display_name ~ '^Игрок( [0-9]+)?$'
          or not exists (
            select 1
              from integration.legacy_game_player_bindings binding
             where binding.tenant_id = summary.tenant_id
               and binding.user_id = summary.user_id
          )
        )`,
    [
      input.tenantId,
      userId,
      cleanText(input.participant.displayName, 200, 'Игрок'),
      input.participant.level,
      input.participant.levelValue,
    ],
  );
}

async function bindExistingGameParticipant(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly participant: LegacyGameImportParticipant;
    readonly externalVersion: string;
    readonly userId: string;
    readonly proofKind: 'VIVA_PROFILE' | 'VIEWER_PHONE';
    readonly now: Date;
  },
): Promise<boolean> {
  const previousUserId = await findMapping(
    client,
    input.tenantId,
    'game_player',
    input.participant.externalId,
  );
  const userId = await resolvePlayer(
    client,
    input.tenantId,
    input.participant,
    input.externalVersion,
    input.userId,
    input.proofKind,
  );
  if (!previousUserId || previousUserId === userId) return false;

  const source = await queryOne<
    {
      readonly id: string;
      readonly role: 'ORGANIZER' | 'PLAYER';
    } & QueryResultRow
  >(
    client,
    `select id, role
       from games.participations
      where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'
      for update`,
    [input.tenantId, input.gameId, previousUserId],
  );
  if (!source) return false;
  const target = await queryOne<{ readonly id: string } & QueryResultRow>(
    client,
    `select id
       from games.participations
      where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'
      for update`,
    [input.tenantId, input.gameId, userId],
  );
  if (target) {
    await client.query(
      `update games.participations
          set state = 'LEFT', left_at = $4, updated_at = $4
        where tenant_id = $1 and game_id = $2 and id = $3`,
      [input.tenantId, input.gameId, source.id, input.now.toISOString()],
    );
    await client.query(
      `update games.participations
          set role = $4, payment_state = $5, updated_at = $6
        where tenant_id = $1 and game_id = $2 and id = $3`,
      [
        input.tenantId,
        input.gameId,
        target.id,
        source.role,
        input.participant.paymentState,
        input.now.toISOString(),
      ],
    );
  } else {
    await client.query(
      `update games.participations
          set user_id = $4, payment_state = $5, updated_at = $6
        where tenant_id = $1 and game_id = $2 and id = $3`,
      [
        input.tenantId,
        input.gameId,
        source.id,
        userId,
        input.participant.paymentState,
        input.now.toISOString(),
      ],
    );
  }
  if (source.role === 'ORGANIZER') {
    await client.query(
      `update games.games set organizer_user_id = $3, updated_at = $4
        where tenant_id = $1 and id = $2 and organizer_user_id = $5`,
      [input.tenantId, input.gameId, userId, input.now.toISOString(), previousUserId],
    );
  }
  return true;
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
    readonly participantUserBindings: ReadonlyMap<
      string,
      { readonly userId: string; readonly proofKind: 'VIVA_PROFILE' | 'VIEWER_PHONE' }
    >;
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
      let aggregateChanged = false;
      let lifecycleChanged = false;
      const desiredLifecycleState = lifecycle(input.snapshot, input.now);
      const projectionEventId = randomUUID();
      // Refresh legacy presentation fields only when the previous import used a generated
      // fallback title. Deliberately preserve a later canonical title or any local edit.
      const generatedTitle = generatedLegacyTitle(input.snapshot);
      const sourceTitle = cleanText(input.snapshot.title, 160, generatedTitle);
      if (input.snapshot.station.courtName || sourceTitle !== generatedTitle) {
        const updated = await client.query(
          `update games.games
              set title = case when title = $4 then $3 else title end,
                  court_name = coalesce($5, court_name),
                  updated_at = now()
            where tenant_id = $1 and id = $2
              and (title = $4 or court_name is distinct from coalesce($5, court_name))`,
          [
            input.tenantId,
            existingGameId,
            sourceTitle,
            generatedTitle,
            input.snapshot.station.courtName
              ? cleanText(input.snapshot.station.courtName, 120, 'Корт')
              : null,
          ],
        );
        aggregateChanged = (updated.rowCount ?? 0) > 0;
      }
      if (desiredLifecycleState !== 'SCHEDULED') {
        const lifecycleUpdate = await client.query(
          `update games.games
              set lifecycle_state = $3,
                  result_state = case
                    when $3 = 'FINISHED' and result_state = 'NOT_AVAILABLE'
                      then 'AWAITING_SUBMISSION'
                    when $3 = 'CANCELLED' then 'VOID'
                    else result_state
                  end,
                  started_at = case
                    when $3 in ('IN_PROGRESS', 'FINISHED')
                      then coalesce(started_at, $5::timestamptz)
                    else started_at
                  end,
                  finished_at = case
                    when $3 = 'FINISHED' then coalesce(finished_at, $6::timestamptz)
                    else finished_at
                  end,
                  cancelled_at = case
                    when $3 = 'CANCELLED' then coalesce(cancelled_at, $4::timestamptz)
                    else cancelled_at
                  end,
                  cancellation_reason_code = case
                    when $3 = 'CANCELLED' then coalesce(cancellation_reason_code, 'OTHER')
                    else cancellation_reason_code
                  end,
                  updated_at = $4
            where tenant_id = $1 and id = $2
              and (
                ($3 = 'IN_PROGRESS' and lifecycle_state = 'SCHEDULED')
                or ($3 = 'FINISHED' and lifecycle_state in ('SCHEDULED', 'IN_PROGRESS'))
                or ($3 = 'CANCELLED' and lifecycle_state in ('SCHEDULED', 'IN_PROGRESS'))
              )`,
          [
            input.tenantId,
            existingGameId,
            desiredLifecycleState,
            input.now.toISOString(),
            input.snapshot.startsAt,
            input.snapshot.endsAt,
          ],
        );
        lifecycleChanged = (lifecycleUpdate.rowCount ?? 0) > 0;
        aggregateChanged = lifecycleChanged || aggregateChanged;
      }
      await associateVivaExercise(client, {
        tenantId: input.tenantId,
        gameId: existingGameId,
        vivaExerciseExternalId: input.snapshot.vivaExerciseExternalId,
        externalVersion: input.snapshot.externalVersion,
      });
      for (const participant of input.snapshot.participants) {
        await refreshMappedPlayerSummary(client, {
          tenantId: input.tenantId,
          participant,
        });
      }
      for (const participant of input.snapshot.participants) {
        const binding = input.participantUserBindings.get(participant.externalId);
        if (!binding) continue;
        aggregateChanged =
          (await bindExistingGameParticipant(client, {
            tenantId: input.tenantId,
            gameId: existingGameId,
            participant,
            externalVersion: input.snapshot.externalVersion,
            userId: binding.userId,
            proofKind: binding.proofKind,
            now: input.now,
          })) || aggregateChanged;
      }
      let aggregateRevision: string | undefined;
      if (aggregateChanged) {
        const revision = await queryOne<{ readonly revision: string | number } & QueryResultRow>(
          client,
          `update games.games
              set revision = revision + 1, updated_at = $3
            where tenant_id = $1 and id = $2
            returning revision`,
          [input.tenantId, existingGameId, input.now.toISOString()],
        );
        aggregateRevision = revision ? String(revision.revision) : undefined;
      }
      if (lifecycleChanged && aggregateRevision) {
        const participants = await client.query<{ readonly user_id: string } & QueryResultRow>(
          `select user_id
             from games.participations
            where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
            order by joined_at, id`,
          [input.tenantId, existingGameId],
        );
        const participantUserIds = participants.rows.map((row) => row.user_id);
        const eventType =
          desiredLifecycleState === 'CANCELLED'
            ? 'game.cancelled.v1'
            : desiredLifecycleState === 'FINISHED'
              ? 'game.finished.v1'
              : 'game.started.v1';
        const commonPayload = {
          gameId: existingGameId,
          aggregateRevision,
          causationId: projectionEventId,
          actorUserId: null,
          participantUserIds,
        };
        const event = gameDomainEventSchema.parse({
          id: projectionEventId,
          type: eventType,
          aggregateId: existingGameId,
          tenantId: input.tenantId,
          occurredAt: input.now.toISOString(),
          correlationId: input.correlationId,
          payload:
            eventType === 'game.cancelled.v1'
              ? { ...commonPayload, reasonCode: 'OTHER' as const }
              : commonPayload,
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
           ) values ($1, null, 'LEGACY_GAME_LIFECYCLE_REFRESHED', 'GAME', $2,
                     'SUCCESS', 'EXACT_CUP_SNAPSHOT', $3, $4::jsonb)`,
          [
            input.tenantId,
            existingGameId,
            input.correlationId,
            JSON.stringify({
              revision: Number(aggregateRevision),
              lifecycleState: desiredLifecycleState,
            }),
          ],
        );
      }
      await reconcileLifecycleCommands(client, {
        tenantId: input.tenantId,
        gameId: existingGameId,
        desiredLifecycleState,
        now: input.now,
      });
      return { outcome: 'existing', gameId: existingGameId, projectionEventId };
    }

    const participantIds = new Map<string, string>();
    for (const participant of input.snapshot.participants) {
      participantIds.set(
        participant.externalId,
        await resolvePlayer(
          client,
          input.tenantId,
          participant,
          input.snapshot.externalVersion,
          input.participantUserBindings.get(participant.externalId)?.userId,
          input.participantUserBindings.get(participant.externalId)?.proofKind,
        ),
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
         lifecycle_state, station_id, court_id, court_name, starts_at, ends_at, timezone,
         capacity, waitlist_enabled, payment_mode, level_from, level_to, result_state,
         cancellation_reason_code, cancelled_at, started_at, finished_at, created_at, updated_at
       ) values (
         $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $24
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
        input.snapshot.station.courtName
          ? cleanText(input.snapshot.station.courtName, 120, 'Корт')
          : null,
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

    await reconcileLifecycleCommands(client, {
      tenantId: input.tenantId,
      gameId,
      desiredLifecycleState: state,
      now: input.now,
    });

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
    resolveVivaProfileExternalId(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<{ readonly external_id: string } & QueryResultRow>(
          client,
          `select external_id
             from integration.external_entity_map
            where tenant_id = $1 and external_system = 'VIVA'
              and entity_type = 'viva_profile' and internal_id = $2
            order by last_synced_at desc
            limit 1`,
          [input.tenantId, input.userId],
        );
        return row?.external_id;
      });
    },

    resolveViewerPhoneE164(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<{ readonly phone_e164: string | null } & QueryResultRow>(
          client,
          `select phone_e164
             from profile.user_summaries
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId],
        );
        return row?.phone_e164 ?? undefined;
      });
    },

    async refreshVivaExerciseGameLifecycles(input) {
      const vivaExerciseAssociationIds = [
        ...new Set(input.vivaExerciseAssociationIds.map((id) => id.trim())),
      ]
        .filter(Boolean)
        .slice(0, 100);
      if (vivaExerciseAssociationIds.length === 0) return [];
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const candidates = await client.query<AssociatedLifecycleGameRow>(
          `select game.id, game.revision, game.lifecycle_state, game.starts_at, game.ends_at
             from integration.external_entity_map mapping
             join games.games game
               on game.tenant_id = mapping.tenant_id and game.id = mapping.internal_id
            where mapping.tenant_id = $1 and mapping.external_system = $2
              and mapping.entity_type = 'exercise'
              and mapping.external_id = any($3::text[])
              and game.lifecycle_state in ('SCHEDULED', 'IN_PROGRESS')
              and game.starts_at <= $4::timestamptz
            order by game.starts_at, game.id
            for update of game`,
          [
            input.tenantId,
            VIVA_EXTERNAL_SYSTEM,
            vivaExerciseAssociationIds,
            input.now.toISOString(),
          ],
        );
        const refreshed: { gameId: string; projectionEventId: string }[] = [];
        for (const candidate of candidates.rows) {
          const desiredLifecycleState =
            (candidate.ends_at instanceof Date
              ? candidate.ends_at.getTime()
              : Date.parse(candidate.ends_at)) <= input.now.getTime()
              ? ('FINISHED' as const)
              : ('IN_PROGRESS' as const);
          if (candidate.lifecycle_state === desiredLifecycleState) continue;
          const updated = await queryOne<{ readonly revision: string | number } & QueryResultRow>(
            client,
            `update games.games
                set lifecycle_state = $3,
                    result_state = case
                      when $3 = 'FINISHED' and result_state = 'NOT_AVAILABLE'
                        then 'AWAITING_SUBMISSION'
                      else result_state
                    end,
                    started_at = coalesce(started_at, starts_at),
                    finished_at = case
                      when $3 = 'FINISHED' then coalesce(finished_at, ends_at)
                      else finished_at
                    end,
                    revision = revision + 1,
                    updated_at = $4::timestamptz
              where tenant_id = $1 and id = $2
                and lifecycle_state = $5
              returning revision`,
            [
              input.tenantId,
              candidate.id,
              desiredLifecycleState,
              input.now.toISOString(),
              candidate.lifecycle_state,
            ],
          );
          if (!updated) continue;
          const participants = await client.query<{ readonly user_id: string } & QueryResultRow>(
            `select user_id
               from games.participations
              where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
              order by joined_at, id`,
            [input.tenantId, candidate.id],
          );
          const projectionEventId = randomUUID();
          const event = gameDomainEventSchema.parse({
            id: projectionEventId,
            type: desiredLifecycleState === 'FINISHED' ? 'game.finished.v1' : 'game.started.v1',
            aggregateId: candidate.id,
            tenantId: input.tenantId,
            occurredAt: input.now.toISOString(),
            correlationId: input.correlationId,
            payload: {
              gameId: candidate.id,
              aggregateRevision: String(updated.revision),
              causationId: projectionEventId,
              actorUserId: null,
              participantUserIds: participants.rows.map((row) => row.user_id),
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
               tenant_id, actor_id, action, resource_type, resource_id, result,
               reason, correlation_id, new_value
             ) values ($1, null, 'VIVA_HISTORY_GAME_LIFECYCLE_REFRESHED', 'GAME', $2,
                       'SUCCESS', 'FRESH_VIVA_EXERCISE_ASSOCIATION', $3, $4::jsonb)`,
            [
              input.tenantId,
              candidate.id,
              input.correlationId,
              JSON.stringify({
                revision: Number(updated.revision),
                lifecycleState: desiredLifecycleState,
              }),
            ],
          );
          await reconcileLifecycleCommands(client, {
            tenantId: input.tenantId,
            gameId: candidate.id,
            desiredLifecycleState,
            now: input.now,
          });
          refreshed.push({ gameId: candidate.id, projectionEventId });
        }
        return refreshed;
      });
    },

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
      const participantUserBindings = new Map<
        string,
        { readonly userId: string; readonly proofKind: 'VIVA_PROFILE' | 'VIEWER_PHONE' }
      >();
      for (const binding of input.participantUserBindings ?? []) {
        const previous = participantUserBindings.get(binding.externalId);
        if (previous && previous.userId !== binding.userId) {
          throw new Error('LEGACY_GAME_PARTICIPANT_USER_BINDING_CONFLICT');
        }
        participantUserBindings.set(binding.externalId, {
          userId: binding.userId,
          proofKind: binding.proofKind ?? 'VIVA_PROFILE',
        });
      }
      let skipped = 0;
      for (const snapshot of input.snapshots) {
        const result = await importOne(pool, {
          tenantId: tenant.id,
          snapshot,
          correlationId: input.correlationId,
          now: input.now ?? new Date(),
          participantUserBindings,
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
