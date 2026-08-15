import type { CommunityMemberCountProjectionRepository } from '@phub/database';
import type { Logger } from 'pino';

export async function runCommunityMemberCountReconciliationCycle(options: {
  readonly repository: Pick<
    CommunityMemberCountProjectionRepository,
    'listReconciliationCandidates' | 'reconcileBatch'
  >;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly reconcileBefore: string;
  readonly candidateLimit: number;
  readonly batchSize: number;
}): Promise<{ readonly candidates: number; readonly processed: number }> {
  const communities = await options.repository.listReconciliationCandidates({
    tenantId: options.tenantId,
    reconcileBefore: options.reconcileBefore,
    limit: options.candidateLimit,
  });
  let processed = 0;
  for (const communityId of communities) {
    const result = await options.repository.reconcileBatch({
      tenantId: options.tenantId,
      communityId,
      batchSize: options.batchSize,
    });
    processed += result.processed;
    options.logger.info(
      { tenantId: options.tenantId, communityId, result },
      'community member-count reconciliation batch completed',
    );
  }
  return { candidates: communities.length, processed };
}
