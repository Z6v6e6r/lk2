import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import { homePromotionDeckSchema } from '@phub/home-projection';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import type { LegacyPromotionSource } from './legacy-promotion-source.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';
import {
  completePromotionMediaObjectGc,
  listDuePromotionHomeUsers,
  listDuePromotionMediaObjects,
  loadPromotionMediaSyncRecords,
  persistPromotionHomeSource,
  persistPromotionMedia,
  recordPromotionMediaObjectGcFailure,
  resolvePromotionIds,
} from './promotion-home-repository.js';
import { synchronizePromotionMedia } from './promotion-media-sync.js';

export interface PromotionHomeSyncCycleResult {
  readonly attempted: number;
  readonly synced: number;
  readonly failed: number;
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'PROMOTION_HOME_SYNC_FAILED';
}

export async function runPromotionHomeSyncCycle(input: {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly source: LegacyPromotionSource;
  readonly store: ProfilePhotoObjectStore;
  readonly now?: Date;
}): Promise<PromotionHomeSyncCycleResult> {
  const now = input.now ?? new Date();
  const fetchedAt = now.toISOString();
  const dueBefore = new Date(now.getTime() - input.config.PROMOTIONS_SYNC_INTERVAL_MS);
  const tenants = await input.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true order by id',
  );
  let attempted = 0;
  let synced = 0;
  let failed = 0;
  let remaining = input.config.PROMOTIONS_SYNC_BATCH_SIZE;

  for (const tenant of tenants.rows) {
    if (remaining <= 0) break;
    const users = await listDuePromotionHomeUsers({
      pool: input.pool,
      tenantId: tenant.id,
      dueBefore,
      limit: remaining,
    });
    remaining -= users.length;
    if (users.length === 0) continue;
    attempted += users.length;
    const sourceCorrelationId = randomUUID();
    try {
      const snapshot = await input.source.getSnapshot(sourceCorrelationId);
      const ids = await resolvePromotionIds({
        pool: input.pool,
        tenantId: tenant.id,
        externalIds: snapshot.items.map((item) => item.externalId),
      });
      const candidates = snapshot.items.map((item) => {
        const promotionId = ids.get(item.externalId);
        if (!promotionId) throw new Error('PROMOTION_ID_MAPPING_MISSING');
        return { promotionId, sourceUrl: item.imageSourceUrl };
      });
      const currentMedia = await loadPromotionMediaSyncRecords({
        pool: input.pool,
        tenantId: tenant.id,
        promotionIds: candidates.map((candidate) => candidate.promotionId),
      });
      const media = await synchronizePromotionMedia({
        store: input.store,
        tenantId: tenant.id,
        candidates,
        current: currentMedia,
        fetchedAt,
        allowedHosts: input.config.PROMOTION_IMAGE_ALLOWED_HOSTS.split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        maxBytes: input.config.PROMOTION_IMAGE_MAX_BYTES,
        desktopMaxWidth: input.config.PROMOTION_IMAGE_DESKTOP_MAX_WIDTH,
        desktopMaxHeight: input.config.PROMOTION_IMAGE_DESKTOP_MAX_HEIGHT,
        mobileWidth: input.config.PROMOTION_IMAGE_MOBILE_WIDTH,
        mobileHeight: input.config.PROMOTION_IMAGE_MOBILE_HEIGHT,
        webpQuality: input.config.PROMOTION_IMAGE_WEBP_QUALITY,
        previousObjectRetentionSeconds:
          input.config.PROFILE_PHOTO_URL_TTL_SECONDS +
          input.config.HOME_PROJECTION_MAX_STALE_SECONDS +
          60,
        readUrlTtlSeconds: input.config.PROFILE_PHOTO_URL_TTL_SECONDS,
        timeoutMs: input.config.PROMOTIONS_LEGACY_TIMEOUT_MS,
      });
      const mediaByPromotionId = new Map(media.map((item) => [item.promotionId, item]));
      const promotions = homePromotionDeckSchema.parse({
        rotationEnabled: snapshot.rotationEnabled && snapshot.items.length > 1,
        intervalSeconds: input.config.PROMOTION_ROTATION_INTERVAL_SECONDS,
        items: snapshot.items.map((item) => {
          const promotionId = ids.get(item.externalId);
          const asset = promotionId ? mediaByPromotionId.get(promotionId) : undefined;
          if (!promotionId || !asset) throw new Error('PROMOTION_MEDIA_MAPPING_MISSING');
          return {
            id: promotionId,
            eyebrow: 'Акция',
            title: item.title,
            description: 'Специальное предложение ПадлХАБ.',
            actionLabel: 'Подробнее',
            route: item.href,
            tone: 'lime',
            imageUrl: asset.imageUrl,
            mobileImageUrl: asset.mobileImageUrl,
          };
        }),
      });
      const deleteAfter = new Date(
        now.getTime() +
          (input.config.PROFILE_PHOTO_URL_TTL_SECONDS +
            input.config.HOME_PROJECTION_MAX_STALE_SECONDS +
            60) *
            1_000,
      ).toISOString();
      await persistPromotionMedia({
        pool: input.pool,
        tenantId: tenant.id,
        activePromotionIds: promotions.items.map((item) => item.id),
        assets: media.map((item) => item.persistence),
        deleteAfter,
      });

      for (const userId of users) {
        const correlationId = randomUUID();
        const result = await persistPromotionHomeSource({
          pool: input.pool,
          tenantId: tenant.id,
          userId,
          promotions,
          correlationId,
          fetchedAt,
        });
        synced += 1;
        input.logger.info(
          {
            tenantId: tenant.id,
            userId,
            correlationId,
            sourceUpdatedAt: snapshot.updatedAt,
            promotionCount: promotions.items.length,
            rotationEnabled: promotions.rotationEnabled,
            outcome: result.outcome,
            sourceRevision: result.sourceRevision,
          },
          'promotion Home source synchronized',
        );
      }
    } catch (error) {
      failed += users.length;
      input.logger.warn(
        {
          tenantId: tenant.id,
          correlationId: sourceCorrelationId,
          userCount: users.length,
          code: failureCode(error),
        },
        'promotion Home source synchronization deferred',
      );
    }
  }

  for (const tenant of tenants.rows) {
    const objectKeys = await listDuePromotionMediaObjects({
      pool: input.pool,
      tenantId: tenant.id,
      limit: input.config.PROMOTION_MEDIA_GC_BATCH_SIZE,
    }).catch(() => []);
    for (const objectKey of objectKeys) {
      try {
        await input.store.delete(objectKey);
        await completePromotionMediaObjectGc({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey,
        });
      } catch {
        await recordPromotionMediaObjectGcFailure({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey,
          errorCode: 'PROMOTION_MEDIA_OBJECT_DELETE_FAILED',
        }).catch(() => undefined);
      }
    }
  }
  return { attempted, synced, failed };
}
