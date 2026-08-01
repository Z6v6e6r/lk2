import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface TrainerAvatarRecord {
  readonly trainerId: string;
  readonly displayName: string;
  readonly sourceUrl?: string;
  readonly objectKey?: string;
  readonly contentSha256?: string;
}

export interface TrainerAvatarRepository {
  getByProviderIdentity(
    tenantId: string,
    provider: 'VIVA',
    providerTrainerId: string,
  ): Promise<TrainerAvatarRecord | undefined>;
  save(input: {
    readonly tenantId: string;
    readonly provider: 'VIVA';
    readonly providerTrainerId: string;
    readonly displayName: string;
    readonly sourceUrl?: string;
    readonly objectKey?: string;
    readonly contentSha256?: string;
    readonly syncedAt?: string;
    readonly lastErrorCode?: string;
  }): Promise<TrainerAvatarRecord>;
}

interface TrainerAvatarRow extends QueryResultRow {
  readonly trainer_id: string;
  readonly display_name: string;
  readonly source_url: string | null;
  readonly object_key: string | null;
  readonly content_sha256: string | null;
}

function mapRow(row: TrainerAvatarRow): TrainerAvatarRecord {
  return {
    trainerId: row.trainer_id,
    displayName: row.display_name,
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.object_key ? { objectKey: row.object_key } : {}),
    ...(row.content_sha256 ? { contentSha256: row.content_sha256 } : {}),
  };
}

export function createTrainerAvatarRepository(pool: Pool): TrainerAvatarRepository {
  return {
    getByProviderIdentity(tenantId, provider, providerTrainerId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<TrainerAvatarRow>(
          client,
          `select s.trainer_id, t.display_name, s.source_url, s.object_key, s.content_sha256
             from integration.trainer_avatar_sync s
             join catalog.trainers t
               on t.tenant_id = s.tenant_id and t.id = s.trainer_id
            where s.tenant_id = $1 and s.provider = $2 and s.provider_trainer_id = $3`,
          [tenantId, provider, providerTrainerId],
        );
        return row ? mapRow(row) : undefined;
      });
    },

    save(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `trainer-avatar:${input.provider}:${input.providerTrainerId}`,
        ]);
        const existing = await queryOne<{ readonly trainer_id: string } & QueryResultRow>(
          client,
          `select trainer_id
             from integration.trainer_avatar_sync
            where tenant_id = $1 and provider = $2 and provider_trainer_id = $3
            for update`,
          [input.tenantId, input.provider, input.providerTrainerId],
        );
        const trainerId = existing?.trainer_id;
        const trainer = trainerId
          ? await queryOne<TrainerAvatarRow>(
              client,
              `update catalog.trainers
                  set display_name = $3, updated_at = now()
                where tenant_id = $1 and id = $2
                returning id as trainer_id, display_name, null::text as source_url,
                          null::text as object_key, null::text as content_sha256`,
              [input.tenantId, trainerId, input.displayName],
            )
          : await queryOne<TrainerAvatarRow>(
              client,
              `insert into catalog.trainers (tenant_id, display_name)
               values ($1, $2)
               returning id as trainer_id, display_name, null::text as source_url,
                         null::text as object_key, null::text as content_sha256`,
              [input.tenantId, input.displayName],
            );
        if (!trainer) throw new Error('TRAINER_PROFILE_SAVE_FAILED');
        const row = await queryOne<TrainerAvatarRow>(
          client,
          `insert into integration.trainer_avatar_sync (
             tenant_id, trainer_id, provider, provider_trainer_id, source_url,
             content_sha256, object_key, synced_at, last_error_code
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (tenant_id, provider, provider_trainer_id) do update
             set source_url = coalesce(excluded.source_url, integration.trainer_avatar_sync.source_url),
                 content_sha256 = coalesce(excluded.content_sha256, integration.trainer_avatar_sync.content_sha256),
                 object_key = coalesce(excluded.object_key, integration.trainer_avatar_sync.object_key),
                 synced_at = coalesce(excluded.synced_at, integration.trainer_avatar_sync.synced_at),
                 last_error_code = excluded.last_error_code,
                 updated_at = now()
           returning trainer_id, $10::text as display_name, source_url, object_key, content_sha256`,
          [
            input.tenantId,
            trainer.trainer_id,
            input.provider,
            input.providerTrainerId,
            input.sourceUrl ?? null,
            input.contentSha256 ?? null,
            input.objectKey ?? null,
            input.syncedAt ?? null,
            input.lastErrorCode ?? null,
            input.displayName,
          ],
        );
        if (!row) throw new Error('TRAINER_AVATAR_SAVE_FAILED');
        return mapRow(row);
      });
    },
  };
}
