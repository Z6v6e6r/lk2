import { randomUUID } from 'node:crypto';

import {
  communitySummarySchema,
  type CommunityDirectoryItem,
  type CommunityDirectoryPosition,
  type CommunityDirectoryRepository,
} from '@phub/communities';
import type { WorkerConfig } from '@phub/config';
import { HOME_COMMUNITY_SUMMARY_LIMIT } from '@phub/home-projection';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import {
  deleteCommunityLogoObjectIfSafe,
  listCommunityHomeDeliveryBackfills,
  listDueCommunityHomeUsers,
  listDueCommunityLogoObjects,
  listCommunityLogoDeliveryBackfills,
  loadCommunityLogoSyncRecords,
  persistCommunityHomeSource,
  persistCommunityLogoSignedDelivery,
  recordCommunityLogoObjectGcFailure,
  reserveCommunityLogoObjectUpload,
} from './community-home-repository.js';
import { synchronizeLegacyCommunityLogos } from './community-logo-sync.js';
import type { CommunityLogoSourceResilience } from './community-logo-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

export interface CommunityHomeSyncCycleResult {
  readonly attempted: number;
  readonly synced: number;
  readonly failed: number;
}

const COMMUNITY_DIRECTORY_PAGE_SIZE = 50;
const MAX_COMMUNITIES_PER_USER = 1_000;
const COMMUNITY_LOGO_FETCH_BUDGET_PER_CYCLE = 20;
const COMMUNITY_LOGO_FETCH_CONCURRENCY = 4;

async function listAllCommunityMemberships(input: {
  readonly repository: CommunityDirectoryRepository;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
}): Promise<readonly CommunityDirectoryItem[]> {
  const items: CommunityDirectoryItem[] = [];
  let after: CommunityDirectoryPosition | undefined;
  while (items.length < MAX_COMMUNITIES_PER_USER) {
    const page = await input.repository.listMemberships({
      tenantId: input.tenantId,
      userId: input.userId,
      correlationId: input.correlationId,
      limit: Math.min(COMMUNITY_DIRECTORY_PAGE_SIZE, MAX_COMMUNITIES_PER_USER - items.length),
      ...(after ? { after } : {}),
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
    const last = page.items.at(-1);
    if (!last) throw new Error('COMMUNITY_DIRECTORY_INVALID');
    after = { pinned: last.pinned, sortAt: last.sortAt, id: last.id };
  }
  throw new Error('COMMUNITY_DIRECTORY_LIMIT_EXCEEDED');
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'COMMUNITY_HOME_SYNC_FAILED';
}

function publicApplicationOrigin(config: WorkerConfig): string {
  const candidate =
    config.VIVA_OAUTH_SUCCESS_REDIRECT_URL || config.CORS_ORIGINS.split(',')[0]?.trim();
  if (!candidate) throw new Error('COMMUNITY_MEDIA_PUBLIC_ORIGIN_MISSING');
  return new URL(candidate).origin;
}

export async function runCommunityLogoCompatibilityBackfill(input: {
  readonly pool: Pool;
  readonly config: WorkerConfig;
  readonly logger: Logger;
  readonly store: ProfilePhotoObjectStore;
  readonly now?: Date;
}): Promise<{ readonly logos: number; readonly homes: number; readonly failed: number }> {
  if (
    input.config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED ||
    input.config.COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED !== true
  ) {
    return { logos: 0, homes: 0, failed: 0 };
  }
  const now = input.now ?? new Date();
  const tenants = await input.pool.query<{ id: string }>(
    `select id
       from identity.tenants
      order by id`,
  );
  let logos = 0;
  let homes = 0;
  let failed = 0;
  for (const tenant of tenants.rows) {
    const mappings = await listCommunityLogoDeliveryBackfills({
      pool: input.pool,
      tenantId: tenant.id,
      limit: input.config.COMMUNITY_LOGO_GC_BATCH_SIZE,
    });
    for (const mapping of mappings) {
      try {
        const deliveryUrl = await input.store.createReadUrl(mapping.objectKey);
        const persisted = await persistCommunityLogoSignedDelivery({
          pool: input.pool,
          tenantId: tenant.id,
          communityId: mapping.communityId,
          objectKey: mapping.objectKey,
          deliveryUrl,
          deliveryExpiresAt: new Date(
            now.getTime() + input.config.PROFILE_PHOTO_URL_TTL_SECONDS * 1_000,
          ).toISOString(),
        });
        if (persisted) logos += 1;
      } catch {
        failed += 1;
        input.logger.warn(
          { tenantId: tenant.id, communityId: mapping.communityId },
          'community logo signed-delivery backfill deferred',
        );
      }
    }

    const snapshots = await listCommunityHomeDeliveryBackfills({
      pool: input.pool,
      tenantId: tenant.id,
      limit: input.config.COMMUNITY_HOME_SYNC_BATCH_SIZE,
    });
    for (const snapshot of snapshots) {
      try {
        const records = await loadCommunityLogoSyncRecords({
          pool: input.pool,
          tenantId: tenant.id,
          communityIds: snapshot.communities.map((community) => community.id),
        });
        let changed = false;
        const communities = snapshot.communities.map((community) => {
          const deliveryUrl = records.get(community.id)?.deliveryUrl;
          if (!deliveryUrl || community.logoUrl === deliveryUrl) return community;
          changed = true;
          return { ...community, logoUrl: deliveryUrl };
        });
        if (!changed) continue;
        const result = await persistCommunityHomeSource({
          pool: input.pool,
          tenantId: tenant.id,
          userId: snapshot.userId,
          sourceMode: snapshot.sourceMode,
          communities,
          publicApplicationOrigin: publicApplicationOrigin(input.config),
          stableDeliveryEnabled: false,
          expectedPayloadChecksum: snapshot.payloadChecksum,
          expectedSourceRevision: snapshot.sourceRevision,
          expectedSourceMode: snapshot.sourceMode,
          correlationId: randomUUID(),
          fetchedAt: now.toISOString(),
        });
        if (result.outcome !== 'stale') homes += 1;
      } catch {
        failed += 1;
        input.logger.warn(
          { tenantId: tenant.id, userId: snapshot.userId },
          'community Home signed-delivery backfill deferred',
        );
      }
    }
  }
  return { logos, homes, failed };
}

export async function runCommunityHomeSyncCycle(input: {
  readonly pool: Pool;
  readonly config: WorkerConfig;
  readonly logger: Logger;
  readonly repository: CommunityDirectoryRepository;
  readonly sourceMode: 'LEGACY' | 'LOCAL';
  readonly store: ProfilePhotoObjectStore;
  readonly sourceResilience?: CommunityLogoSourceResilience;
  readonly now?: Date;
}): Promise<CommunityHomeSyncCycleResult> {
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - input.config.COMMUNITY_HOME_SYNC_INTERVAL_MS);
  const tenants = await input.pool.query<{ id: string }>(
    `select id from identity.tenants where active = true order by id`,
  );
  let attempted = 0;
  let synced = 0;
  let failed = 0;
  let remaining = input.config.COMMUNITY_HOME_SYNC_BATCH_SIZE;
  let remainingLogoFetches = COMMUNITY_LOGO_FETCH_BUDGET_PER_CYCLE;

  for (const tenant of tenants.rows) {
    if (remaining <= 0) break;
    const users = await listDueCommunityHomeUsers({
      pool: input.pool,
      tenantId: tenant.id,
      dueBefore,
      limit: remaining,
    });
    remaining -= users.length;
    for (const user of users) {
      attempted += 1;
      const correlationId = randomUUID();
      try {
        const directoryItems = await listAllCommunityMemberships({
          repository: input.repository,
          tenantId: tenant.id,
          userId: user.userId,
          correlationId,
        });
        const logoResults =
          input.sourceMode === 'LEGACY'
            ? await synchronizeLegacyCommunityLogos({
                pool: input.pool,
                store: input.store,
                tenantId: tenant.id,
                items: directoryItems.slice(0, HOME_COMMUNITY_SUMMARY_LIMIT),
                fetchedAt: now.toISOString(),
                allowedHosts: input.config.COMMUNITY_LOGO_ALLOWED_HOSTS.split(',')
                  .map((host) => host.trim())
                  .filter(Boolean),
                maxBytes: input.config.COMMUNITY_LOGO_MAX_BYTES,
                maxDimension: input.config.COMMUNITY_LOGO_MAX_DIMENSION,
                webpQuality: input.config.COMMUNITY_LOGO_WEBP_QUALITY,
                previousObjectRetentionSeconds:
                  input.config.PROFILE_PHOTO_URL_TTL_SECONDS +
                  input.config.HOME_PROJECTION_MAX_STALE_SECONDS +
                  60,
                readUrlTtlSeconds: input.config.PROFILE_PHOTO_URL_TTL_SECONDS,
                stableDeliveryEnabled: input.config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED,
                timeoutMs: input.config.COMMUNITIES_LEGACY_TIMEOUT_MS,
                deferStorePut: true,
                maxConcurrency: COMMUNITY_LOGO_FETCH_CONCURRENCY,
                maxFetches: remainingLogoFetches,
                ...(input.sourceResilience ? { sourceResilience: input.sourceResilience } : {}),
              })
            : [];
        remainingLogoFetches = Math.max(
          0,
          remainingLogoFetches - logoResults.filter((result) => result.fetchAttempted).length,
        );
        const logosByCommunityId = new Map(
          logoResults.map((result) => [result.communityId, result.logoUrl]),
        );
        for (const result of logoResults) {
          if (!result.errorCode) continue;
          input.logger.warn(
            {
              tenantId: tenant.id,
              communityId: result.communityId,
              correlationId,
              code: result.errorCode,
            },
            'community logo synchronization retained the local logo',
          );
        }
        for (const result of logoResults) {
          if (!result.preparedObject) continue;
          const shouldUpload = await reserveCommunityLogoObjectUpload({
            pool: input.pool,
            tenantId: tenant.id,
            communityId: result.communityId,
            objectKey: result.preparedObject.key,
            deleteAfter: result.preparedObject.deleteAfter,
          });
          if (shouldUpload) await input.store.put(result.preparedObject);
        }
        const communities = directoryItems.slice(0, HOME_COMMUNITY_SUMMARY_LIMIT).map((item) =>
          communitySummarySchema.parse({
            id: item.id,
            title: item.title,
            logoUrl: (() => {
              const logo = logosByCommunityId.has(item.id)
                ? (logosByCommunityId.get(item.id) ?? null)
                : item.logoUrl;
              return logo
                ? new URL(logo, `${publicApplicationOrigin(input.config)}/`).toString()
                : null;
            })(),
            isVerified: item.isVerified,
            unreadChatCount: item.unreadChatCount,
            route: `/communities/${item.id}`,
          }),
        );
        const component = await persistCommunityHomeSource({
          pool: input.pool,
          tenantId: tenant.id,
          userId: user.userId,
          sourceMode: input.sourceMode,
          communities,
          publicApplicationOrigin: publicApplicationOrigin(input.config),
          stableDeliveryEnabled: input.config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED,
          ...(logoResults.length > 0
            ? { logoAssets: logoResults.map((result) => result.persistence) }
            : {}),
          correlationId,
          fetchedAt: now.toISOString(),
        });
        synced += 1;
        input.logger.info(
          {
            tenantId: tenant.id,
            userId: user.userId,
            correlationId,
            sourceMode: input.sourceMode,
            directoryCommunityCount: directoryItems.length,
            communityCount: communities.length,
            logoCount: communities.filter((community) => community.logoUrl).length,
            outcome: component.outcome,
            sourceRevision: component.sourceRevision,
          },
          'community Home source synchronized',
        );
      } catch (error) {
        failed += 1;
        input.logger.warn(
          {
            tenantId: tenant.id,
            userId: user.userId,
            correlationId,
            code: failureCode(error),
          },
          'community Home source synchronization deferred',
        );
      }
    }
  }

  for (const tenant of tenants.rows) {
    const dueObjects = await listDueCommunityLogoObjects({
      pool: input.pool,
      tenantId: tenant.id,
      limit: input.config.COMMUNITY_LOGO_GC_BATCH_SIZE,
    }).catch(() => []);
    for (const item of dueObjects) {
      try {
        await deleteCommunityLogoObjectIfSafe({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey: item.objectKey,
          deleteObject: () => input.store.delete(item.objectKey),
        });
      } catch {
        await recordCommunityLogoObjectGcFailure({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey: item.objectKey,
          errorCode: 'COMMUNITY_LOGO_OBJECT_DELETE_FAILED',
        }).catch(() => undefined);
        input.logger.warn(
          { tenantId: tenant.id, code: 'COMMUNITY_LOGO_OBJECT_DELETE_FAILED' },
          'community logo object cleanup deferred',
        );
      }
    }
  }
  return { attempted, synced, failed };
}
