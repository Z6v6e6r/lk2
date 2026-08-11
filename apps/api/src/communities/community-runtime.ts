import {
  createCommunityDirectoryService,
  createCommunityReadExperienceService,
  paginateCommunityDirectoryItems,
  type CommunityDirectoryItem,
  type CommunityDirectoryRepository,
  type CommunityDirectoryService,
  type CommunityReadExperienceService,
} from '@phub/communities';
import type { AppConfig } from '@phub/config';
import {
  createCommunityLegacyBridgeRepository,
  createLocalCommunityDirectoryRepository,
} from '@phub/database';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { LegacyCommunityReadRepository } from './legacy-community-read-repository.js';
import { LegacyCommunityExperienceRepository } from './legacy-community-experience-repository.js';

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
