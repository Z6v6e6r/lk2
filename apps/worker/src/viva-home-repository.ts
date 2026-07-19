import { createHash, randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import {
  HOME_PROJECTION_COMPONENT_EVENT,
  homeProjectionComponentPayloadSchema,
  type HomeProjectionComponentPayload,
} from '@phub/home-projection';
import type { VivaHomeSourceSnapshot } from '@phub/viva-adapter';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface VivaHomeDelegation {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly providerTenantKey: string;
  readonly issuer: string;
  readonly subject: string;
  readonly refreshTokenCiphertext: string;
  readonly encryptionKeyVersion: string;
  readonly refreshExpiresAt?: string;
}

interface DelegationRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly provider_tenant_key: string;
  readonly issuer: string;
  readonly subject: string;
  readonly refresh_token_ciphertext: string;
  readonly encryption_key_version: string;
  readonly refresh_expires_at: Date | string | null;
}

interface MappingRow extends QueryResultRow {
  readonly internal_id: string;
}

interface CanonicalOpenGameRosterRow extends QueryResultRow {
  readonly exercise_external_id: string;
  readonly capacity: number;
  readonly profile_id: string;
  readonly display_name: string;
  readonly photo_url: string | null;
  readonly level_label: string | null;
}

interface RevisionRow extends QueryResultRow {
  readonly source_revision: string;
  readonly payload_checksum: string;
}

interface ProfilePhotoRow extends QueryResultRow {
  readonly photo_url: string | null;
  readonly source_url: string | null;
  readonly source_etag: string | null;
  readonly source_last_modified: string | null;
  readonly content_sha256: string | null;
  readonly object_key: string | null;
  readonly synced_at: Date | string | null;
}

export interface ProfilePhotoSyncRecord {
  readonly avatarUrl?: string;
  readonly sourceUrl?: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256?: string;
  readonly objectKey?: string;
  readonly syncedAt?: string;
}

export interface ProfilePhotoPersistence {
  readonly avatarUrl: string | null;
  readonly sourceUrl?: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256?: string;
  readonly objectKey?: string;
  readonly supersededObjectKey?: string;
  readonly deleteAfter?: string;
  readonly syncedAt: string;
}

export interface ProfilePhotoObjectGcItem {
  readonly objectKey: string;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapDelegation(row: DelegationRow): VivaHomeDelegation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerTenantKey: row.provider_tenant_key,
    issuer: row.issuer,
    subject: row.subject,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    encryptionKeyVersion: row.encryption_key_version,
    ...(row.refresh_expires_at
      ? { refreshExpiresAt: new Date(row.refresh_expires_at).toISOString() }
      : {}),
  };
}

export function loadProfilePhotoSyncRecord(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<ProfilePhotoSyncRecord> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const row = (
      await client.query<ProfilePhotoRow>(
        `select p.photo_url, s.source_url, s.source_etag, s.source_last_modified,
                s.content_sha256, s.object_key, s.synced_at
           from profile.user_summaries p
           left join integration.user_profile_photo_sync s
             on s.tenant_id = p.tenant_id and s.user_id = p.user_id
          where p.tenant_id = $1 and p.user_id = $2`,
        [input.tenantId, input.userId],
      )
    ).rows[0];
    if (!row) throw new Error('PROFILE_SUMMARY_NOT_FOUND');
    return {
      ...(row.photo_url ? { avatarUrl: row.photo_url } : {}),
      ...(row.source_url ? { sourceUrl: row.source_url } : {}),
      ...(row.source_etag ? { sourceEtag: row.source_etag } : {}),
      ...(row.source_last_modified ? { sourceLastModified: row.source_last_modified } : {}),
      ...(row.content_sha256 ? { contentSha256: row.content_sha256 } : {}),
      ...(row.object_key ? { objectKey: row.object_key } : {}),
      ...(row.synced_at ? { syncedAt: new Date(row.synced_at).toISOString() } : {}),
    };
  });
}

export function listDueProfilePhotoObjects(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly limit: number;
}): Promise<readonly ProfilePhotoObjectGcItem[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const rows = await client.query<{ object_key: string } & QueryResultRow>(
      `select object_key
         from integration.profile_photo_object_gc
        where tenant_id = $1 and delete_after <= now()
        order by delete_after, object_key
        limit $2`,
      [input.tenantId, input.limit],
    );
    return rows.rows.map((row) => ({ objectKey: row.object_key }));
  });
}

export function completeProfilePhotoObjectGc(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `delete from integration.profile_photo_object_gc
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey],
    );
  });
}

export function recordProfilePhotoObjectGcFailure(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly errorCode: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `update integration.profile_photo_object_gc
          set attempts = attempts + 1,
              last_error_code = $3,
              delete_after = now() + interval '15 minutes',
              updated_at = now()
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey, input.errorCode.slice(0, 100)],
    );
  });
}

export function listDueVivaHomeDelegations(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly dueBefore: Date;
  readonly failureBefore: Date;
  readonly limit: number;
}): Promise<readonly VivaHomeDelegation[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const rows = await client.query<DelegationRow>(
      `select d.id, d.tenant_id, d.user_id, b.provider_tenant_key,
              d.issuer, d.subject, d.refresh_token_ciphertext,
              d.encryption_key_version, d.refresh_expires_at
         from integration.user_delegations d
         join integration.identity_provider_bindings b
           on b.tenant_id = d.tenant_id and b.provider = 'VIVA'
         left join lateral (
           select count(*)::integer as component_count, min(c.last_synced_at) as oldest_sync
             from integration.viva_home_source_components c
            where c.tenant_id = d.tenant_id and c.user_id = d.user_id
         ) sync on true
        where d.tenant_id = $1
          and d.provider = 'VIVA'
          and d.revoked_at is null
          and (d.refresh_expires_at is null or d.refresh_expires_at > now())
          and (d.refresh_failed_at is null or d.refresh_failed_at < $4)
          and (coalesce(sync.component_count, 0) < 3 or sync.oldest_sync < $2)
        order by sync.oldest_sync asc nulls first, d.updated_at asc
        limit $3`,
      [input.tenantId, input.dueBefore, input.limit, input.failureBefore],
    );
    return rows.rows.map(mapDelegation);
  });
}

export function saveRefreshedVivaHomeDelegation(input: {
  readonly pool: Pool;
  readonly delegation: VivaHomeDelegation;
  readonly refreshTokenCiphertext: string;
  readonly encryptionKeyVersion: string;
  readonly refreshExpiresAt?: Date;
  readonly correlationId: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.delegation.tenantId, async (client) => {
    const result = await client.query(
      `update integration.user_delegations
          set refresh_token_ciphertext = $4,
              encryption_key_version = $5,
              refresh_expires_at = coalesce($6, refresh_expires_at),
              last_refreshed_at = now(),
              refresh_failed_at = null,
              refresh_failure_code = null,
              updated_at = now()
        where tenant_id = $1 and id = $2 and user_id = $3 and revoked_at is null`,
      [
        input.delegation.tenantId,
        input.delegation.id,
        input.delegation.userId,
        input.refreshTokenCiphertext,
        input.encryptionKeyVersion,
        input.refreshExpiresAt ?? null,
      ],
    );
    if (result.rowCount !== 1) throw new Error('VIVA_DELEGATION_NOT_ACTIVE');
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id
       ) values ($1, $2, 'VIVA_HOME_DELEGATION_REFRESHED', 'VIVA_DELEGATION', $3,
                 'SUCCESS', $4)`,
      [
        input.delegation.tenantId,
        input.delegation.userId,
        input.delegation.id,
        input.correlationId,
      ],
    );
  });
}

export function recordVivaHomeSyncFailure(input: {
  readonly pool: Pool;
  readonly delegation: VivaHomeDelegation;
  readonly code: string;
  readonly correlationId: string;
}): Promise<void> {
  const safeCode = input.code.replace(/[^A-Z0-9_]/gi, '_').slice(0, 100);
  return withTenantTransaction(input.pool, input.delegation.tenantId, async (client) => {
    await client.query(
      `update integration.user_delegations
          set refresh_failed_at = now(), refresh_failure_code = $4, updated_at = now()
        where tenant_id = $1 and id = $2 and user_id = $3 and revoked_at is null`,
      [input.delegation.tenantId, input.delegation.id, input.delegation.userId, safeCode],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, reason, correlation_id
       ) values ($1, $2, 'VIVA_HOME_SYNC', 'VIVA_DELEGATION', $3,
                 'FAILURE', $4, $5)`,
      [
        input.delegation.tenantId,
        input.delegation.userId,
        input.delegation.id,
        safeCode,
        input.correlationId,
      ],
    );
  });
}

async function resolveInternalId(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly entityType: 'viva_profile' | 'booking' | 'subscription';
  readonly externalId: string;
  readonly fetchedAt: string;
  readonly requiredInternalId?: string;
}): Promise<string> {
  const row = (
    await input.client.query<MappingRow>(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         external_version, last_synced_at, sync_status, sync_error_code
       ) values ($1, 'VIVA', $2, coalesce($5::uuid, gen_random_uuid()), $3,
                 $4::text, $6::timestamptz, 'synced', null)
       on conflict (tenant_id, external_system, entity_type, external_id)
       do update set external_version = excluded.external_version,
                     last_synced_at = excluded.last_synced_at,
                     sync_status = 'synced',
                     sync_error_code = null
       returning internal_id`,
      [
        input.tenantId,
        input.entityType,
        input.externalId,
        input.fetchedAt,
        input.requiredInternalId ?? null,
        input.fetchedAt,
      ],
    )
  ).rows[0];
  if (!row) throw new Error('EXTERNAL_ID_MAPPING_FAILED');
  if (input.requiredInternalId && row.internal_id !== input.requiredInternalId) {
    throw new Error('EXTERNAL_ID_MAPPING_CONFLICT');
  }
  return row.internal_id;
}

type HomeParticipant = {
  readonly profileId: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly nickname: null;
  readonly avatarUrl: string | null;
  readonly level: string | null;
};

interface CanonicalOpenGameRoster {
  readonly participants: HomeParticipant[];
  readonly openSlots: number;
}

function nameParts(displayName: string): {
  readonly firstName: string;
  readonly lastName: string | null;
} {
  const [firstName, ...rest] = displayName.trim().split(/\s+/);
  return { firstName: firstName || displayName, lastName: rest.length ? rest.join(' ') : null };
}

/**
 * Resolves a VIVA exercise only through the server-side integration map. The returned roster is
 * owned by the local Games aggregate; it intentionally contains no external IDs, payment data,
 * phones or provider image source URLs.
 */
async function resolveCanonicalOpenGameRosters(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly exerciseExternalIds: readonly string[];
}): Promise<ReadonlyMap<string, CanonicalOpenGameRoster>> {
  const exerciseExternalIds = [...new Set(input.exerciseExternalIds)].slice(0, 6);
  if (exerciseExternalIds.length === 0) return new Map();
  const rows = await input.client.query<CanonicalOpenGameRosterRow>(
    `select e.external_id as exercise_external_id, g.capacity, p.user_id as profile_id,
            s.display_name, s.photo_url, s.level_label
       from integration.external_entity_map e
       join games.games g
         on g.tenant_id = e.tenant_id and g.id = e.internal_id
       join games.participations p
         on p.tenant_id = g.tenant_id and p.game_id = g.id and p.state = 'ACTIVE'
       join profile.user_summaries s
         on s.tenant_id = p.tenant_id and s.user_id = p.user_id
      where e.tenant_id = $1
        and e.external_system = 'VIVA'
        and e.entity_type = 'exercise'
        and e.external_id = any($2::text[])
        and g.lifecycle_state in ('SCHEDULED', 'IN_PROGRESS')
      order by e.external_id, p.joined_at, p.user_id`,
    [input.tenantId, exerciseExternalIds],
  );
  const rosters = new Map<string, { capacity: number; participants: HomeParticipant[] }>();
  for (const row of rows.rows) {
    const displayName = row.display_name.trim().slice(0, 200);
    if (!displayName) continue;
    const entry = rosters.get(row.exercise_external_id) ?? {
      capacity: Math.min(4, Math.max(0, row.capacity)),
      participants: [],
    };
    if (entry.participants.length < 4) {
      const names = nameParts(displayName);
      entry.participants.push({
        profileId: row.profile_id,
        displayName,
        firstName: names.firstName.slice(0, 100),
        lastName: names.lastName?.slice(0, 100) ?? null,
        nickname: null,
        avatarUrl: row.photo_url,
        level: row.level_label,
      });
    }
    rosters.set(row.exercise_external_id, entry);
  }
  return new Map(
    [...rosters.entries()]
      .filter(([, roster]) => roster.participants.length > 0)
      .map(([exerciseExternalId, roster]) => [
        exerciseExternalId,
        {
          participants: roster.participants,
          openSlots: Math.max(0, roster.capacity - roster.participants.length),
        },
      ]),
  );
}

function asHomeValues(input: {
  readonly userId: string;
  readonly snapshot: VivaHomeSourceSnapshot;
  readonly avatarUrl: string | null;
  readonly bookingIds: ReadonlyMap<string, string>;
  readonly subscriptionIds: ReadonlyMap<string, string>;
  readonly gameRosters: ReadonlyMap<string, CanonicalOpenGameRoster>;
}): readonly Pick<HomeProjectionComponentPayload, 'component' | 'value'>[] {
  return [
    {
      component: 'profile',
      value: {
        userId: input.userId,
        displayName: input.snapshot.profile.displayName,
        firstName: input.snapshot.profile.firstName ?? null,
        lastName: input.snapshot.profile.lastName ?? null,
        avatarUrl: input.avatarUrl,
        ...(input.snapshot.profile.phoneLast4
          ? { phoneLast4: input.snapshot.profile.phoneLast4 }
          : {}),
        balanceMinor: input.snapshot.profile.balanceMinor,
        currency: 'RUB',
        level: input.snapshot.profile.level,
      },
    },
    {
      component: 'upcoming',
      value: input.snapshot.upcoming.map((item) => {
        const id = input.bookingIds.get(item.externalId);
        if (!id) throw new Error('BOOKING_ID_MAPPING_MISSING');
        const canonicalRoster = item.exerciseExternalId
          ? input.gameRosters.get(item.exerciseExternalId)
          : undefined;
        return {
          id,
          // A local roster association makes this a Games card even when the Viva booking type
          // is the generic exercise/training type.
          kind: canonicalRoster ? ('game' as const) : ('training' as const),
          title: item.title,
          startsAt: item.startsAt,
          venue: item.venue,
          status: item.status,
          route: `/bookings/${id}`,
          // The canonical Games roster wins when its VIVA exercise association is known. Until
          // that migration has reached an event, preserve the only participant Viva proves here.
          participants: canonicalRoster?.participants ?? [
            {
              profileId: input.userId,
              displayName: input.snapshot.profile.displayName,
              firstName: input.snapshot.profile.firstName ?? input.snapshot.profile.displayName,
              lastName: input.snapshot.profile.lastName ?? null,
              nickname: null,
              avatarUrl: input.avatarUrl,
              level: input.snapshot.profile.level.label,
            },
          ],
          ...(canonicalRoster ? { openSlots: canonicalRoster.openSlots } : {}),
        };
      }),
    },
    {
      component: 'subscriptions',
      value: input.snapshot.subscriptions.map((item) => {
        const id = input.subscriptionIds.get(item.externalId);
        if (!id) throw new Error('SUBSCRIPTION_ID_MAPPING_MISSING');
        return {
          id,
          title: item.title,
          status: item.status,
          remainingUnits: item.remainingUnits,
          validUntil: item.validUntil,
          route: `/subscriptions/${id}`,
        };
      }),
    },
  ];
}

export function persistVivaHomeSource(input: {
  readonly pool: Pool;
  readonly delegation: VivaHomeDelegation;
  readonly snapshot: VivaHomeSourceSnapshot;
  readonly profilePhoto?: ProfilePhotoPersistence;
  readonly correlationId: string;
}): Promise<readonly { component: string; revision: string }[]> {
  return withTenantTransaction(input.pool, input.delegation.tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      input.delegation.userId,
    ]);
    await resolveInternalId({
      client,
      tenantId: input.delegation.tenantId,
      entityType: 'viva_profile',
      externalId: input.snapshot.profile.externalId,
      fetchedAt: input.snapshot.fetchedAt,
      requiredInternalId: input.delegation.userId,
    });
    const levelLabel = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'].includes(
      input.snapshot.profile.level.label,
    )
      ? input.snapshot.profile.level.label
      : null;
    await client.query(
      `update profile.user_summaries
          set level_label = $3, updated_at = now()
        where tenant_id = $1 and user_id = $2`,
      [input.delegation.tenantId, input.delegation.userId, levelLabel],
    );
    if (input.profilePhoto) {
      await client.query(
        `update profile.user_summaries
            set photo_url = $3, updated_at = now()
          where tenant_id = $1 and user_id = $2`,
        [input.delegation.tenantId, input.delegation.userId, input.profilePhoto.avatarUrl],
      );
      if (
        input.profilePhoto.sourceUrl &&
        input.profilePhoto.contentSha256 &&
        input.profilePhoto.objectKey
      ) {
        await client.query(
          `insert into integration.user_profile_photo_sync (
             tenant_id, user_id, source_url, source_etag, source_last_modified,
             content_sha256, object_key, synced_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (tenant_id, user_id) do update set
             source_url = excluded.source_url,
             source_etag = excluded.source_etag,
             source_last_modified = excluded.source_last_modified,
             content_sha256 = excluded.content_sha256,
             object_key = excluded.object_key,
             synced_at = excluded.synced_at,
             updated_at = now()`,
          [
            input.delegation.tenantId,
            input.delegation.userId,
            input.profilePhoto.sourceUrl,
            input.profilePhoto.sourceEtag ?? null,
            input.profilePhoto.sourceLastModified ?? null,
            input.profilePhoto.contentSha256,
            input.profilePhoto.objectKey,
            input.profilePhoto.syncedAt,
          ],
        );
        await client.query(
          `delete from integration.profile_photo_object_gc
            where tenant_id = $1 and object_key = $2`,
          [input.delegation.tenantId, input.profilePhoto.objectKey],
        );
      } else {
        await client.query(
          `delete from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2`,
          [input.delegation.tenantId, input.delegation.userId],
        );
      }
      if (input.profilePhoto.supersededObjectKey && input.profilePhoto.deleteAfter) {
        await client.query(
          `insert into integration.profile_photo_object_gc (
             tenant_id, object_key, delete_after
           ) values ($1, $2, $3)
           on conflict (tenant_id, object_key) do update set
             delete_after = least(integration.profile_photo_object_gc.delete_after,
                                  excluded.delete_after),
             updated_at = now()`,
          [
            input.delegation.tenantId,
            input.profilePhoto.supersededObjectKey,
            input.profilePhoto.deleteAfter,
          ],
        );
      }
    }
    const bookingIds = new Map<string, string>();
    for (const item of input.snapshot.upcoming) {
      bookingIds.set(
        item.externalId,
        await resolveInternalId({
          client,
          tenantId: input.delegation.tenantId,
          entityType: 'booking',
          externalId: item.externalId,
          fetchedAt: input.snapshot.fetchedAt,
        }),
      );
    }
    const subscriptionIds = new Map<string, string>();
    for (const item of input.snapshot.subscriptions) {
      subscriptionIds.set(
        item.externalId,
        await resolveInternalId({
          client,
          tenantId: input.delegation.tenantId,
          entityType: 'subscription',
          externalId: item.externalId,
          fetchedAt: input.snapshot.fetchedAt,
        }),
      );
    }
    const gameRosters = await resolveCanonicalOpenGameRosters({
      client,
      tenantId: input.delegation.tenantId,
      exerciseExternalIds: input.snapshot.upcoming.flatMap((item) =>
        item.exerciseExternalId ? [item.exerciseExternalId] : [],
      ),
    });

    const results: { component: string; revision: string }[] = [];
    for (const item of asHomeValues({
      userId: input.delegation.userId,
      snapshot: input.snapshot,
      avatarUrl: input.profilePhoto?.avatarUrl ?? null,
      bookingIds,
      subscriptionIds,
      gameRosters,
    })) {
      const valueChecksum = checksum(item.value);
      const row = (
        await client.query<RevisionRow>(
          `insert into integration.viva_home_source_components (
             tenant_id, user_id, component, source_revision, payload,
             payload_checksum, correlation_id, fetched_at
           ) values ($1, $2, $3, 1, $4::jsonb, $5, $6, $7)
           on conflict (tenant_id, user_id, component) do update set
             source_revision = integration.viva_home_source_components.source_revision + 1,
             payload = excluded.payload,
             payload_checksum = excluded.payload_checksum,
             correlation_id = excluded.correlation_id,
             fetched_at = excluded.fetched_at,
             last_synced_at = now(),
             updated_at = now()
           returning source_revision::text as source_revision, payload_checksum`,
          [
            input.delegation.tenantId,
            input.delegation.userId,
            item.component,
            JSON.stringify(item.value),
            valueChecksum,
            input.correlationId,
            input.snapshot.fetchedAt,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('VIVA_HOME_SOURCE_REVISION_FAILED');
      const payload = homeProjectionComponentPayloadSchema.parse({
        userId: input.delegation.userId,
        component: item.component,
        componentRevision: row.source_revision,
        value: item.value,
      });
      const eventId = randomUUID();
      await client.query(
        `insert into audit.outbox_events (
           id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          eventId,
          input.delegation.tenantId,
          HOME_PROJECTION_COMPONENT_EVENT,
          input.delegation.userId,
          input.correlationId,
          JSON.stringify(payload),
          input.snapshot.fetchedAt,
        ],
      );
      results.push({ component: item.component, revision: row.source_revision });
    }
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, correlation_id, new_value
       ) values ($1, $2, 'VIVA_HOME_SYNC', 'HOME_SOURCE', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        input.delegation.tenantId,
        input.delegation.userId,
        input.correlationId,
        JSON.stringify({
          producer: 'VIVA_HOME_SYNC',
          fetchedAt: input.snapshot.fetchedAt,
          upcomingCount: input.snapshot.upcoming.length,
          subscriptionCount: input.snapshot.subscriptions.length,
          revisions: Object.fromEntries(
            results.map((result) => [result.component, result.revision]),
          ),
        }),
      ],
    );
    return results;
  });
}
