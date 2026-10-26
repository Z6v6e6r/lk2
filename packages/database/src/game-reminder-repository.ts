import type { PoolClient, QueryResultRow } from 'pg';

import { profileReachableSql } from './profile-reachability-repository.js';

interface CanonicalGameRow extends QueryResultRow {
  readonly revision: string;
  readonly title: string;
  readonly starts_at: Date;
  readonly lifecycle_state: string;
  readonly location_name: string;
  readonly legacy_source: boolean;
  readonly legacy_mapping: boolean;
}

interface LegacySourceRow extends QueryResultRow {
  readonly source_revision: string;
  readonly title: string;
  readonly starts_at: Date;
  readonly location_name: string;
  readonly source_state: 'SCHEDULED' | 'CANCELLED' | 'MISSING' | 'OUT_OF_WINDOW';
  readonly source_checked_at: Date;
  readonly status_checked_at: Date | null;
  readonly healthy: boolean;
  readonly source_generation_id: string;
  readonly status_generation_id: string;
  readonly error_code: string | null;
}

interface GameReminderRecipientRow extends QueryResultRow {
  readonly user_id: string;
}

export interface GameStartReminderTarget {
  readonly gameId: string;
  readonly revision: string;
  readonly serviceTitle: string;
  readonly startsAt: string;
  readonly locationName: string;
  readonly recipientUserIds: readonly string[];
}

export type GameStartReminderReadResult =
  | { readonly state: 'READY'; readonly target: GameStartReminderTarget }
  | {
      readonly state:
        'GAME_UNAVAILABLE' | 'SOURCE_STALE' | 'RECIPIENT_NOT_PARTICIPATING' | 'RECIPIENT_UNBOUND';
    };

function isFresh(checkedAt: Date | null, now: Date, maxAgeMs: number): boolean {
  const age = checkedAt ? now.getTime() - checkedAt.getTime() : Number.NaN;
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

/** Native games use ACTIVE canonical participations, including private games. A game carrying a
 * legacy mapping never falls back to that path: it requires the isolated current-generation source
 * projection and immutable verified player bindings. */
interface GameStartReminderReadInput {
  readonly tenantId: string;
  readonly gameId: string;
  readonly now: Date;
  readonly maxLegacySourceAgeMs: number;
  readonly expectedRevision?: string;
  readonly onlyRecipientUserId?: string;
}

async function readGameStartReminderTargetInternal(
  client: PoolClient,
  input: GameStartReminderReadInput,
  preparingGenerationId?: string,
): Promise<GameStartReminderReadResult> {
  const owner = (
    await client.query<CanonicalGameRow>(
      `select game.revision::text,game.title,game.starts_at,game.lifecycle_state,
              coalesce(location.short_title,location.title,'Площадка') location_name,
              exists(
                select 1 from integration.external_entity_map mapping
                 where mapping.tenant_id=game.tenant_id and mapping.internal_id=game.id
                   and mapping.external_system='LK_LEGACY_SNAPSHOT'
                   and mapping.entity_type='game'
              ) legacy_mapping,
              (
                exists(
                  select 1 from integration.external_entity_map mapping
                   where mapping.tenant_id=game.tenant_id and mapping.internal_id=game.id
                     and mapping.external_system='LK_LEGACY_SNAPSHOT'
                     and mapping.entity_type='game'
                ) or exists(
                  select 1 from integration.legacy_game_roster_sync_state mirror
                   where mirror.tenant_id=game.tenant_id and mirror.game_id=game.id
                     and mirror.mode='MIRROR'
                ) or exists(
                  select 1 from notifications.legacy_game_reminder_sources source
                   where source.tenant_id=game.tenant_id and source.game_id=game.id
                )
              ) legacy_source
         from games.games game
         left join locations.profiles location
           on location.tenant_id=game.tenant_id and location.id=game.station_id
        where game.tenant_id=$1 and game.id=$2
          and not exists(
            select 1 from integration.legacy_game_merge_redirects redirect
             where redirect.tenant_id=game.tenant_id and redirect.source_game_id=game.id
          )
        for share of game`,
      [input.tenantId, input.gameId],
    )
  ).rows[0];
  if (!owner) return { state: 'GAME_UNAVAILABLE' };

  if (owner.legacy_source) {
    if (!owner.legacy_mapping) return { state: 'SOURCE_STALE' };
    const source = (
      await client.query<LegacySourceRow>(
        `select source.source_revision::text,source.title,source.starts_at,
                source.location_name,source.source_state,source.source_checked_at,
                status.checked_at status_checked_at,status.healthy,
                source.generation_id source_generation_id,
                status.generation_id status_generation_id,status.error_code
           from notifications.legacy_game_reminder_sources source
           join notifications.legacy_game_reminder_source_status status
             on status.tenant_id=source.tenant_id
          where source.tenant_id=$1 and source.game_id=$2
            and source.generation_id=status.generation_id
            and exists(
              select 1 from integration.legacy_game_roster_sync_state mirror
               where mirror.tenant_id=source.tenant_id and mirror.game_id=source.game_id
                 and mirror.mode='MIRROR'
            )
          for share of source,status`,
        [input.tenantId, input.gameId],
      )
    ).rows[0];
    const preparing =
      preparingGenerationId !== undefined &&
      source?.healthy === false &&
      source.error_code === 'REFRESH_IN_PROGRESS' &&
      source.source_generation_id === preparingGenerationId &&
      source.status_generation_id === preparingGenerationId;
    const finalized =
      source?.healthy === true &&
      source.source_generation_id === source.status_generation_id &&
      isFresh(source.status_checked_at, input.now, input.maxLegacySourceAgeMs);
    if (
      !source ||
      (!preparing && !finalized) ||
      !isFresh(source.source_checked_at, input.now, input.maxLegacySourceAgeMs)
    )
      return { state: 'SOURCE_STALE' };
    if (
      source.source_state !== 'SCHEDULED' ||
      source.starts_at.getTime() <= input.now.getTime() ||
      (input.expectedRevision !== undefined && input.expectedRevision !== source.source_revision)
    )
      return { state: 'GAME_UNAVAILABLE' };

    const recipients = await client.query<GameReminderRecipientRow>(
      `select recipient.user_id
         from notifications.legacy_game_reminder_recipients recipient
         join identity.users account
           on account.tenant_id=recipient.tenant_id and account.id=recipient.user_id
        where recipient.tenant_id=$1 and recipient.game_id=$2
          and recipient.source_revision=$3::bigint and account.status='ACTIVE'
          and ($4::uuid is null or recipient.user_id=$4)
          and ${profileReachableSql({ tenantParam: '$1', userParam: 'recipient.user_id' })}
        order by recipient.user_id`,
      [input.tenantId, input.gameId, source.source_revision, input.onlyRecipientUserId ?? null],
    );
    if (input.onlyRecipientUserId && recipients.rowCount !== 1)
      return { state: 'RECIPIENT_UNBOUND' };
    return {
      state: 'READY',
      target: {
        gameId: input.gameId,
        revision: source.source_revision,
        serviceTitle: source.title,
        startsAt: source.starts_at.toISOString(),
        locationName: source.location_name,
        recipientUserIds: recipients.rows.map((row) => row.user_id),
      },
    };
  }

  if (owner.lifecycle_state !== 'SCHEDULED' || owner.starts_at.getTime() <= input.now.getTime())
    return { state: 'GAME_UNAVAILABLE' };
  if (input.expectedRevision !== undefined && input.expectedRevision !== owner.revision)
    return { state: 'GAME_UNAVAILABLE' };
  const recipients = await client.query<GameReminderRecipientRow>(
    `select participant.user_id
       from games.participations participant
       join identity.users account
         on account.tenant_id=participant.tenant_id and account.id=participant.user_id
      where participant.tenant_id=$1 and participant.game_id=$2
        and participant.state='ACTIVE' and account.status='ACTIVE'
        and ($3::uuid is null or participant.user_id=$3)
        and ${profileReachableSql({ tenantParam: '$1', userParam: 'participant.user_id' })}
      order by participant.user_id`,
    [input.tenantId, input.gameId, input.onlyRecipientUserId ?? null],
  );
  if (input.onlyRecipientUserId && recipients.rowCount !== 1)
    return { state: 'RECIPIENT_NOT_PARTICIPATING' };
  return {
    state: 'READY',
    target: {
      gameId: input.gameId,
      revision: owner.revision,
      serviceTitle: owner.title,
      startsAt: owner.starts_at.toISOString(),
      locationName: owner.location_name,
      recipientUserIds: recipients.rows.map((row) => row.user_id),
    },
  };
}

export async function readGameStartReminderTarget(
  client: PoolClient,
  input: GameStartReminderReadInput,
): Promise<GameStartReminderReadResult> {
  return readGameStartReminderTargetInternal(client, input);
}

/** Internal source-finalization reader. It can observe only the exact generation that the same
 * transaction is preparing; normal queue and provider paths never receive this capability. */
export async function readPreparingLegacyGameStartReminderTarget(
  client: PoolClient,
  input: GameStartReminderReadInput & { readonly generationId: string },
): Promise<GameStartReminderReadResult> {
  return readGameStartReminderTargetInternal(client, input, input.generationId);
}
