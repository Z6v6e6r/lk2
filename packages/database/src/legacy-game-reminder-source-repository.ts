import { createHash } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';
import { profileReachableSql } from './profile-reachability-repository.js';

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface TrackedRow extends QueryResultRow {
  readonly game_id: string;
  readonly external_ids: string[];
}

interface SourceRow extends QueryResultRow {
  readonly source_revision: string | number;
  readonly source_external_version: string;
  readonly source_updated_at: Date;
  readonly fingerprint: string;
  readonly source_state: 'SCHEDULED' | 'CANCELLED' | 'MISSING' | 'OUT_OF_WINDOW';
}

export interface LegacyGameReminderSourceSnapshot {
  readonly externalId: string;
  readonly externalAliases?: readonly string[];
  readonly externalVersion: string;
  readonly sourceUpdatedAt?: string | null;
  readonly vivaExerciseExternalId: string | null;
  readonly title: string;
  readonly kind: string;
  readonly visibility: string;
  readonly cancelled: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly station: {
    readonly externalId: string;
    readonly externalAliases?: readonly string[];
    readonly name: string;
    readonly courtExternalId: string | null;
    readonly courtExternalAliases?: readonly string[];
    readonly courtName: string | null;
  };
  readonly capacity: number;
  readonly waitlistEnabled: boolean;
  readonly paymentMode: string;
  readonly levelFrom: string | null;
  readonly levelTo: string | null;
  readonly organizerExternalId: string;
  readonly participants: readonly {
    readonly externalId: string;
    readonly externalAliases?: readonly string[];
    readonly displayName: string;
    readonly level: string | null;
    readonly levelValue: number | null;
    readonly role: string;
    readonly paymentState: string;
    readonly avatarSourceUrl: string | null;
  }[];
  readonly viewerParticipantExternalId?: string | null;
}

export interface LegacyGameReminderTrackedTarget {
  readonly gameId: string;
  readonly externalIds: readonly string[];
}

export interface LegacyGameReminderCycleAdmission {
  readonly tenantId: string;
  readonly generationId: string;
  readonly tracked: readonly LegacyGameReminderTrackedTarget[];
}

export interface LegacyGameReminderCycleResult {
  readonly tenantId: string;
  readonly generationId: string;
  readonly changedGameIds: readonly string[];
  readonly refreshGameIds: readonly string[];
  readonly unchanged: number;
  readonly missing: number;
  readonly skippedUnmapped: number;
}

function sourceIds(snapshot: LegacyGameReminderSourceSnapshot): string[] {
  return [...new Set([snapshot.externalId, ...(snapshot.externalAliases ?? [])])];
}

function participantIds(snapshot: LegacyGameReminderSourceSnapshot): string[] {
  return [
    ...new Set(
      snapshot.participants.flatMap((participant) => [
        participant.externalId,
        ...(participant.externalAliases ?? []),
      ]),
    ),
  ];
}

function sourceState(
  snapshot: LegacyGameReminderSourceSnapshot,
  now: Date,
  windowTo: Date,
): SourceRow['source_state'] {
  if (snapshot.cancelled) return 'CANCELLED';
  const startsAt = Date.parse(snapshot.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= now.getTime() || startsAt >= windowTo.getTime())
    return 'OUT_OF_WINDOW';
  return 'SCHEDULED';
}

function fingerprint(input: {
  readonly snapshot: LegacyGameReminderSourceSnapshot;
  readonly state: SourceRow['source_state'];
  readonly recipientUserIds: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        externalVersion: input.snapshot.externalVersion,
        sourceUpdatedAt: input.snapshot.sourceUpdatedAt,
        state: input.state,
        title: input.snapshot.title,
        startsAt: input.snapshot.startsAt,
        endsAt: input.snapshot.endsAt,
        timezone: input.snapshot.timezone,
        locationName: input.snapshot.station.name,
        recipientUserIds: [...input.recipientUserIds].sort(),
      }),
    )
    .digest('hex');
}

async function resolveMappedMirrorGame(
  client: PoolClient,
  tenantId: string,
  snapshot: LegacyGameReminderSourceSnapshot,
): Promise<string | undefined> {
  const result = await client.query<{ game_id: string }>(
    `select distinct mapping.internal_id game_id
       from integration.external_entity_map mapping
       join integration.legacy_game_roster_sync_state mirror
         on mirror.tenant_id=mapping.tenant_id and mirror.game_id=mapping.internal_id
        and mirror.mode='MIRROR'
      where mapping.tenant_id=$1 and mapping.external_system='LK_LEGACY_SNAPSHOT'
        and mapping.entity_type='game' and mapping.external_id=any($2::text[])
        and not exists(
          select 1 from integration.legacy_game_merge_redirects redirect
           where redirect.tenant_id=mapping.tenant_id
             and redirect.source_game_id=mapping.internal_id
        )
      order by mapping.internal_id`,
    [tenantId, sourceIds(snapshot)],
  );
  if (result.rows.length > 1) throw new Error('LEGACY_GAME_REMINDER_MAPPING_AMBIGUOUS');
  return result.rows[0]?.game_id;
}

async function resolveVerifiedRecipients(
  client: PoolClient,
  tenantId: string,
  snapshot: LegacyGameReminderSourceSnapshot,
): Promise<string[]> {
  const ids = participantIds(snapshot);
  if (ids.length === 0) return [];
  const result = await client.query<{ user_id: string }>(
    `select distinct binding.user_id
       from integration.legacy_game_player_bindings binding
       join identity.users account
         on account.tenant_id=binding.tenant_id and account.id=binding.user_id
      where binding.tenant_id=$1
        and binding.source_player_association_id=any($2::text[])
        and account.status='ACTIVE'
        and ${profileReachableSql({ tenantParam: '$1', userParam: 'binding.user_id' })}
      order by binding.user_id`,
    [tenantId, ids],
  );
  return result.rows.map((row) => row.user_id);
}

export async function beginLegacyGameReminderSourceCycle(
  pool: Pool,
  input: {
    readonly tenantKey: string;
    readonly generationId: string;
    readonly now: Date;
    readonly trackedLimit: number;
  },
): Promise<LegacyGameReminderCycleAdmission> {
  const tenant = (
    await pool.query<TenantRow>(
      'select id from identity.tenants where tenant_key=$1 and active=true',
      [input.tenantKey],
    )
  ).rows[0];
  if (!tenant) throw new Error('LEGACY_GAME_REMINDER_TENANT_NOT_FOUND');
  await withTenantTransaction(pool, tenant.id, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `legacy-game-reminder-source:${tenant.id}`,
    ]);
    await client.query(
      `insert into notifications.legacy_game_reminder_source_status(
         tenant_id,generation_id,healthy,attempt_started_at,checked_at,error_code,updated_at
       ) values($1,$2,false,$3,null,'REFRESH_IN_PROGRESS',clock_timestamp())
       on conflict(tenant_id) do update set generation_id=excluded.generation_id,healthy=false,
         attempt_started_at=excluded.attempt_started_at,checked_at=null,
         error_code='REFRESH_IN_PROGRESS',updated_at=clock_timestamp()`,
      [tenant.id, input.generationId, input.now.toISOString()],
    );
  });
  return withTenantTransaction(pool, tenant.id, async (client) => {
    const tracked = await client.query<TrackedRow>(
      `select source.game_id,array_agg(distinct mapping.external_id order by mapping.external_id) external_ids
         from notifications.legacy_game_reminder_sources source
         join integration.legacy_game_roster_sync_state mirror
           on mirror.tenant_id=source.tenant_id and mirror.game_id=source.game_id
          and mirror.mode='MIRROR'
         join integration.external_entity_map mapping
           on mapping.tenant_id=source.tenant_id and mapping.internal_id=source.game_id
          and mapping.external_system='LK_LEGACY_SNAPSHOT' and mapping.entity_type='game'
        where source.tenant_id=$1 and source.source_state='SCHEDULED'
        group by source.game_id
        order by source.game_id
        limit $2`,
      [tenant.id, input.trackedLimit + 1],
    );
    if (tracked.rows.length > input.trackedLimit)
      throw new Error('LEGACY_GAME_REMINDER_TRACKED_LIMIT_EXCEEDED');
    if (tracked.rows.some((row) => row.external_ids.length === 0))
      throw new Error('LEGACY_GAME_REMINDER_TRACKED_MAPPING_MISSING');
    return {
      tenantId: tenant.id,
      generationId: input.generationId,
      tracked: tracked.rows.map((row) => ({
        gameId: row.game_id,
        externalIds: row.external_ids,
      })),
    };
  });
}

export async function failLegacyGameReminderSourceCycle(
  pool: Pool,
  input: {
    readonly tenantId: string;
    readonly generationId: string;
    readonly errorCode: string;
  },
): Promise<void> {
  await withTenantTransaction(pool, input.tenantId, (client) =>
    client.query(
      `update notifications.legacy_game_reminder_source_status
          set healthy=false,checked_at=null,error_code=$3,updated_at=clock_timestamp()
        where tenant_id=$1 and generation_id=$2`,
      [input.tenantId, input.generationId, input.errorCode],
    ),
  );
}

export async function completeLegacyGameReminderSourceCycle(
  pool: Pool,
  input: {
    readonly admission: LegacyGameReminderCycleAdmission;
    readonly snapshots: readonly LegacyGameReminderSourceSnapshot[];
    readonly now: Date;
    readonly windowTo: Date;
    readonly beforeFinalize: (
      client: PoolClient,
      result: LegacyGameReminderCycleResult,
    ) => Promise<void>;
  },
): Promise<LegacyGameReminderCycleResult> {
  return withTenantTransaction(pool, input.admission.tenantId, async (client) => {
    // All scenario paths acquire this tenant lock before a target or source/status row.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-admin:${input.admission.tenantId}`,
    ]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `legacy-game-reminder-source:${input.admission.tenantId}`,
    ]);
    const status = await client.query(
      `select 1 from notifications.legacy_game_reminder_source_status
        where tenant_id=$1 and generation_id=$2 and healthy=false for update`,
      [input.admission.tenantId, input.admission.generationId],
    );
    if (status.rowCount !== 1) throw new Error('LEGACY_GAME_REMINDER_GENERATION_STALE');
    const changedGameIds = new Set<string>();
    const refreshGameIds = new Set<string>();
    const observedGameIds = new Set<string>();
    let unchanged = 0;
    let skippedUnmapped = 0;
    for (const snapshot of input.snapshots) {
      if (!snapshot.sourceUpdatedAt || !Number.isFinite(Date.parse(snapshot.sourceUpdatedAt)))
        throw new Error('LEGACY_GAME_REMINDER_SOURCE_ORDERING_UNAVAILABLE');
      const gameId = await resolveMappedMirrorGame(client, input.admission.tenantId, snapshot);
      if (!gameId) {
        skippedUnmapped += 1;
        continue;
      }
      if (observedGameIds.has(gameId)) throw new Error('LEGACY_GAME_REMINDER_SOURCE_DUPLICATE');
      observedGameIds.add(gameId);
      refreshGameIds.add(gameId);
      const recipientUserIds = await resolveVerifiedRecipients(
        client,
        input.admission.tenantId,
        snapshot,
      );
      const state = sourceState(snapshot, input.now, input.windowTo);
      const nextFingerprint = fingerprint({ snapshot, state, recipientUserIds });
      const previous = (
        await client.query<SourceRow>(
          `select source_revision,source_external_version,source_updated_at,fingerprint,source_state
             from notifications.legacy_game_reminder_sources
            where tenant_id=$1 and game_id=$2 for update`,
          [input.admission.tenantId, gameId],
        )
      ).rows[0];
      const incomingUpdatedAt = Date.parse(snapshot.sourceUpdatedAt);
      const previousUpdatedAt = previous?.source_updated_at.getTime();
      if (previousUpdatedAt !== undefined && incomingUpdatedAt < previousUpdatedAt)
        throw new Error('LEGACY_GAME_REMINDER_SOURCE_STALE');
      if (
        previousUpdatedAt !== undefined &&
        incomingUpdatedAt === previousUpdatedAt &&
        previous?.source_external_version !== snapshot.externalVersion
      )
        throw new Error('LEGACY_GAME_REMINDER_SOURCE_REVISION_CONFLICT');
      const changed = !previous || previous.fingerprint !== nextFingerprint;
      const revision = previous ? Number(previous.source_revision) + (changed ? 1 : 0) : 1;
      await client.query(
        `insert into notifications.legacy_game_reminder_sources(
           tenant_id,game_id,source_revision,source_external_version,source_updated_at,
           source_checked_at,generation_id,source_state,fingerprint,title,starts_at,ends_at,
           timezone,location_name,updated_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp())
         on conflict(tenant_id,game_id) do update set
           source_revision=excluded.source_revision,
           source_external_version=excluded.source_external_version,
           source_updated_at=excluded.source_updated_at,
           source_checked_at=excluded.source_checked_at,
           generation_id=excluded.generation_id,source_state=excluded.source_state,
           fingerprint=excluded.fingerprint,title=excluded.title,starts_at=excluded.starts_at,
           ends_at=excluded.ends_at,timezone=excluded.timezone,
           location_name=excluded.location_name,updated_at=clock_timestamp()`,
        [
          input.admission.tenantId,
          gameId,
          revision,
          snapshot.externalVersion,
          snapshot.sourceUpdatedAt,
          input.now.toISOString(),
          input.admission.generationId,
          state,
          nextFingerprint,
          snapshot.title,
          snapshot.startsAt,
          snapshot.endsAt,
          snapshot.timezone,
          snapshot.station.name,
        ],
      );
      if (changed) {
        await client.query(
          `delete from notifications.legacy_game_reminder_recipients
            where tenant_id=$1 and game_id=$2`,
          [input.admission.tenantId, gameId],
        );
        for (const userId of recipientUserIds)
          await client.query(
            `insert into notifications.legacy_game_reminder_recipients(
               tenant_id,game_id,user_id,source_revision
             ) values($1,$2,$3,$4)`,
            [input.admission.tenantId, gameId, userId, revision],
          );
        changedGameIds.add(gameId);
      } else unchanged += 1;
    }

    let missing = 0;
    for (const tracked of input.admission.tracked) {
      if (observedGameIds.has(tracked.gameId)) continue;
      refreshGameIds.add(tracked.gameId);
      const previous = (
        await client.query<SourceRow>(
          `select source_revision,source_external_version,source_updated_at,fingerprint,source_state
             from notifications.legacy_game_reminder_sources
            where tenant_id=$1 and game_id=$2 for update`,
          [input.admission.tenantId, tracked.gameId],
        )
      ).rows[0];
      if (!previous) throw new Error('LEGACY_GAME_REMINDER_TRACKED_SOURCE_MISSING');
      const missingFingerprint = createHash('sha256')
        .update(`${previous.fingerprint}:MISSING`)
        .digest('hex');
      await client.query(
        `update notifications.legacy_game_reminder_sources
            set source_revision=source_revision+case when source_state='MISSING' then 0 else 1 end,
                source_checked_at=$3,generation_id=$4,source_state='MISSING',
                fingerprint=$5,
                updated_at=clock_timestamp()
          where tenant_id=$1 and game_id=$2`,
        [
          input.admission.tenantId,
          tracked.gameId,
          input.now.toISOString(),
          input.admission.generationId,
          previous.source_state === 'MISSING' ? previous.fingerprint : missingFingerprint,
        ],
      );
      await client.query(
        `delete from notifications.legacy_game_reminder_recipients
          where tenant_id=$1 and game_id=$2`,
        [input.admission.tenantId, tracked.gameId],
      );
      if (previous.source_state !== 'MISSING') changedGameIds.add(tracked.gameId);
      missing += 1;
    }
    const result = {
      tenantId: input.admission.tenantId,
      generationId: input.admission.generationId,
      changedGameIds: [...changedGameIds],
      refreshGameIds: [...refreshGameIds].sort(),
      unchanged,
      missing,
      skippedUnmapped,
    } satisfies LegacyGameReminderCycleResult;
    await input.beforeFinalize(client, result);
    const finalized = await client.query(
      `update notifications.legacy_game_reminder_source_status
          set healthy=true,checked_at=$3,tracked_count=$4,observed_count=$5,
              skipped_unmapped_count=$6,error_code=null,updated_at=clock_timestamp()
        where tenant_id=$1 and generation_id=$2 and healthy=false
          and error_code='REFRESH_IN_PROGRESS'`,
      [
        input.admission.tenantId,
        input.admission.generationId,
        input.now.toISOString(),
        input.admission.tracked.length,
        observedGameIds.size,
        skippedUnmapped,
      ],
    );
    if (finalized.rowCount !== 1) throw new Error('LEGACY_GAME_REMINDER_GENERATION_STALE');
    return result;
  });
}
