import { randomUUID } from 'node:crypto';

import {
  communitySummarySchema,
  type CommunityDirectoryItem,
  type CommunityDirectoryPosition,
  type CommunityDirectoryRepository,
} from '@phub/communities';
import type { AppConfig } from '@phub/config';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import {
  completeCommunityLogoObjectGc,
  listDueCommunityHomeUsers,
  listDueCommunityLogoObjects,
  persistCommunityHomeSource,
  recordCommunityLogoObjectGcFailure,
} from './community-home-repository.js';
import { synchronizeLegacyCommunityLogos } from './community-logo-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

export interface CommunityHomeSyncCycleResult {
  readonly attempted: number;
  readonly synced: number;
  readonly failed: number;
}

const COMMUNITY_DIRECTORY_PAGE_SIZE = 50;
const MAX_COMMUNITIES_PER_USER = 1_000;

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

export async function runCommunityHomeSyncCycle(input: {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly repository: CommunityDirectoryRepository;
  readonly sourceMode: 'LEGACY' | 'LOCAL';
  readonly store: ProfilePhotoObjectStore;
  readonly now?: Date;
}): Promise<CommunityHomeSyncCycleResult> {
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - input.config.HOME_VIVA_SYNC_INTERVAL_MS);
  const tenants = await input.pool.query<{ id: string }>(
    `select id from identity.tenants where active = true order by id`,
  );
  let attempted = 0;
  let synced = 0;
  let failed = 0;
  let remaining = input.config.HOME_VIVA_SYNC_BATCH_SIZE;

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
                items: directoryItems,
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
                timeoutMs: input.config.COMMUNITIES_LEGACY_TIMEOUT_MS,
              })
            : [];
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
        const communities = directoryItems.slice(0, 5).map((item) =>
          communitySummarySchema.parse({
            id: item.id,
            title: item.title,
            logoUrl: logosByCommunityId.has(item.id)
              ? (logosByCommunityId.get(item.id) ?? null)
              : item.logoUrl,
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
        await input.store.delete(item.objectKey);
        await completeCommunityLogoObjectGc({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey: item.objectKey,
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
