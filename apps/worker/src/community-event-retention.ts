import { randomUUID } from 'node:crypto';

import type { CommunityEventRetentionRepository } from '@phub/database';
import type { Logger } from 'pino';

export interface CommunityEventRetentionCycleResult {
  readonly claimed: number;
  readonly purged: number;
  readonly claimLost: number;
  readonly failures: number;
}

export async function runCommunityEventRetentionCycle(options: {
  readonly repository: CommunityEventRetentionRepository;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly candidateBatchSize: number;
  readonly eventBatchSize: number;
  readonly leaseMs: number;
  readonly claimTokenFactory?: () => string;
}): Promise<CommunityEventRetentionCycleResult> {
  const claimToken = (options.claimTokenFactory ?? randomUUID)();
  const communities = await options.repository.claimDue({
    tenantId: options.tenantId,
    claimToken,
    batchSize: options.candidateBatchSize,
    leaseMs: options.leaseMs,
  });
  let purged = 0;
  let claimLost = 0;
  let failures = 0;
  for (const communityId of communities) {
    try {
      const result = await options.repository.purgeClaimed({
        tenantId: options.tenantId,
        communityId,
        claimToken,
        batchSize: options.eventBatchSize,
        correlationId: `community-event-retention:${randomUUID()}`,
      });
      if (result.outcome === 'claim_lost') {
        claimLost += 1;
        options.logger.warn(
          { tenantId: options.tenantId, communityId },
          'community event retention claim lost',
        );
      } else {
        purged += result.deleted;
        if (result.deleted > 0) {
          options.logger.info(
            { tenantId: options.tenantId, communityId, result },
            'community durable events purged',
          );
        }
      }
    } catch (error) {
      failures += 1;
      options.logger.error(
        { error, tenantId: options.tenantId, communityId },
        'community event retention purge failed',
      );
      try {
        await options.repository.releaseClaim({
          tenantId: options.tenantId,
          communityId,
          claimToken,
        });
      } catch (releaseError) {
        options.logger.error(
          { error: releaseError, tenantId: options.tenantId, communityId },
          'community event retention claim release failed',
        );
      }
    }
  }
  return { claimed: communities.length, purged, claimLost, failures };
}
