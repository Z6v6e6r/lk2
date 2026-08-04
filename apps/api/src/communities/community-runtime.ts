import {
  createCommunityCreateService,
  createCommunityDirectoryService,
  createCommunityReadExperienceService,
  createCommunityMembershipPinService,
  createCommunityMembershipLifecycleService,
  createCommunityReadService,
  createCommunityDirectInviteService,
  createCommunityOwnershipTransferService,
  createCommunityContentService,
  createCommunityContentModerationService,
  createCommunityEventRecoveryService,
  createCommunityMediaService,
  paginateCommunityDirectoryItems,
  type CommunityCreateService,
  type CommunityDirectoryItem,
  type CommunityDirectoryRepository,
  type CommunityDirectoryService,
  type CommunityReadExperienceService,
  type CommunityMembershipPinService,
  type CommunityMembershipLifecycleService,
  type CommunityReadService,
  type CommunityDirectInviteService,
  type CommunityOwnershipTransferService,
  type CommunityContentService,
  type CommunityContentModerationService,
  type CommunityEventRecoveryService,
  type CommunityMediaService,
  type CommunityMediaObjectInspector,
  type CommunityMediaUploadSigner,
} from '@phub/communities';
import type { AppConfig } from '@phub/config';
import {
  createCommunityCreateRepository,
  createCommunityLegacyBridgeRepository,
  createCommunityMembershipPinRepository,
  createCommunityMembershipLifecycleRepository,
  createCommunityReadRepository,
  createCommunityDirectInviteRepository,
  createCommunityOwnershipTransferRepository,
  createCommunityContentRepository,
  createCommunityContentModerationRepository,
  createCommunityEventRecoveryRepository,
  createCommunityMediaRepository,
  createLocalCommunityDirectoryRepository,
} from '@phub/database';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { LegacyCommunityReadRepository } from './legacy-community-read-repository.js';
import { LegacyCommunityExperienceRepository } from './legacy-community-experience-repository.js';
import type { CommunityMediaObjectStore } from './community-media-object-store.js';
import type { CommunityMediaDeliveryAuthorizer } from './community-media-routes.js';

const mockItems: readonly CommunityDirectoryItem[] = [
  {
    id: '42c05c91-da23-4dc5-bf97-3d136a2d12bd',
    title: 'Padel Friends',
    logoUrl: null,
    isVerified: true,
    unreadChatCount: 2,
    memberRank: 3,
    pinned: true,
    sortAt: '2026-07-17T10:00:00.000Z',
  },
  {
    id: 'c522103f-05aa-4ef1-a3a4-645d9a78b397',
    title: 'Команда Север',
    logoUrl: null,
    isVerified: false,
    unreadChatCount: 1,
    memberRank: 11,
    pinned: false,
    sortAt: '2026-07-16T10:00:00.000Z',
  },
  {
    id: '92e25178-32e4-4fed-8964-5e758f858b0e',
    title: 'Турнирный клуб',
    logoUrl: null,
    isVerified: true,
    unreadChatCount: 0,
    memberRank: 2,
    pinned: false,
    sortAt: '2026-07-15T10:00:00.000Z',
  },
];

function mockRepository(): CommunityDirectoryRepository {
  return {
    listMemberships: ({ limit, after }) =>
      Promise.resolve(paginateCommunityDirectoryItems(mockItems, limit, after)),
  };
}

export function createCommunityMembershipPinRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityMembershipPinService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityMembershipPinService(createCommunityMembershipPinRepository(input.pool));
}

export function createCommunityMembershipLifecycleRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityMembershipLifecycleService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityMembershipLifecycleService(
    createCommunityMembershipLifecycleRepository(input.pool),
  );
}

export function createCommunityCreateRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityCreateService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityCreateService(createCommunityCreateRepository(input.pool));
}

export function createCommunityReadRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityReadService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityReadService(createCommunityReadRepository(input.pool));
}

export function createCommunityDirectInviteRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityDirectInviteService | undefined {
  if (
    input.config.COMMUNITIES_READ_MODE !== 'local' ||
    !input.config.COMMUNITY_INVITES_ENABLED ||
    !input.config.COMMUNITY_INVITE_TOKEN_KEYS ||
    !input.config.COMMUNITY_INVITE_ACTIVE_KEY_ID
  ) {
    return undefined;
  }
  const serializedKeys = JSON.parse(input.config.COMMUNITY_INVITE_TOKEN_KEYS) as Record<
    string,
    string
  >;
  const tokenKeys = Object.fromEntries(
    Object.entries(serializedKeys).map(([keyId, value]) => [keyId, Buffer.from(value, 'base64')]),
  );
  return createCommunityDirectInviteService(createCommunityDirectInviteRepository(input.pool), {
    tokenKeys,
    activeKeyId: input.config.COMMUNITY_INVITE_ACTIVE_KEY_ID,
  });
}

export function createCommunityOwnershipTransferRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityOwnershipTransferService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityOwnershipTransferService(
    createCommunityOwnershipTransferRepository(input.pool),
  );
}

export function createCommunityContentRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityContentService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityContentService(createCommunityContentRepository(input.pool));
}

export function createCommunityContentModerationRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityContentModerationService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityContentModerationService(
    createCommunityContentModerationRepository(input.pool),
  );
}

export function createCommunityEventRecoveryRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
}): CommunityEventRecoveryService | undefined {
  if (input.config.COMMUNITIES_READ_MODE !== 'local') return undefined;
  return createCommunityEventRecoveryService(createCommunityEventRecoveryRepository(input.pool));
}

export function createCommunityMediaRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly objectStore: CommunityMediaObjectStore &
    CommunityMediaUploadSigner &
    CommunityMediaObjectInspector;
}):
  | {
      readonly service: CommunityMediaService;
      readonly deliveryAuthorizer: CommunityMediaDeliveryAuthorizer;
      readonly moderationAuthorizer: CommunityMediaDeliveryAuthorizer;
    }
  | undefined {
  if (!input.config.COMMUNITY_MEDIA_ENABLED || input.config.COMMUNITIES_READ_MODE !== 'local') {
    return undefined;
  }
  const repository = createCommunityMediaRepository(input.pool);
  return {
    service: createCommunityMediaService({
      repository,
      uploadSigner: input.objectStore,
      objectInspector: input.objectStore,
    }),
    deliveryAuthorizer: {
      async authorizeVariant(authorization) {
        const variant = await repository.getAuthorizedVariant(authorization);
        return variant
          ? {
              outcome: 'found' as const,
              objectKey: variant.objectKey,
              versionId: variant.objectVersion,
            }
          : { outcome: 'not_found' as const };
      },
    },
    moderationAuthorizer: {
      async authorizeVariant(authorization) {
        const variant = await repository.getModerationVariant({
          tenantId: authorization.tenantId,
          actorUserId: authorization.viewerUserId,
          communityId: authorization.communityId,
          mediaId: authorization.mediaId,
          variant: authorization.variant,
        });
        return variant
          ? {
              outcome: 'found' as const,
              objectKey: variant.objectKey,
              versionId: variant.objectVersion,
            }
          : { outcome: 'not_found' as const };
      },
    },
  };
}

export function createCommunityDirectoryRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly logger: Logger;
}): CommunityDirectoryService {
  let repository: CommunityDirectoryRepository;
  switch (input.config.COMMUNITIES_READ_MODE) {
    case 'local':
      repository = createLocalCommunityDirectoryRepository(input.pool);
      break;
    case 'legacy':
      repository = new LegacyCommunityReadRepository({
        baseUrl: input.config.COMMUNITIES_LEGACY_BASE_URL,
        timeoutMs: input.config.COMMUNITIES_LEGACY_TIMEOUT_MS,
        maxAttempts: input.config.COMMUNITIES_LEGACY_MAX_ATTEMPTS,
        circuitFailureThreshold: input.config.COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
        circuitResetMs: input.config.COMMUNITIES_LEGACY_CIRCUIT_RESET_MS,
        cacheTtlMs: input.config.COMMUNITIES_LEGACY_CACHE_TTL_MS,
        bridge: createCommunityLegacyBridgeRepository(input.pool),
        onMetric: (metric) => input.logger.info({ metric }, 'legacy community read'),
      });
      break;
    case 'mock':
      repository = mockRepository();
      break;
  }
  return createCommunityDirectoryService(repository);
}

export function createCommunityReadExperienceRuntime(input: {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly logger: Logger;
}): CommunityReadExperienceService | undefined {
  if (
    input.config.COMMUNITIES_READ_MODE !== 'legacy' ||
    (!input.config.COMMUNITY_LEGACY_READ_DETAIL_ENABLED &&
      !input.config.COMMUNITY_LEGACY_READ_FEED_ENABLED &&
      !input.config.COMMUNITY_LEGACY_READ_CHAT_ENABLED &&
      !input.config.COMMUNITY_LEGACY_READ_RATING_ENABLED)
  )
    return undefined;
  return createCommunityReadExperienceService(
    new LegacyCommunityExperienceRepository({
      baseUrl: input.config.COMMUNITIES_LEGACY_BASE_URL,
      timeoutMs: input.config.COMMUNITIES_LEGACY_TIMEOUT_MS,
      maxAttempts: input.config.COMMUNITIES_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: input.config.COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: input.config.COMMUNITIES_LEGACY_CIRCUIT_RESET_MS,
      onMetric: (metric) => input.logger.info({ metric }, 'legacy community experience read'),
      bridge: createCommunityLegacyBridgeRepository(input.pool),
    }),
  );
}
