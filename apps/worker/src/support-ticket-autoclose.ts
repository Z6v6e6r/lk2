import type { SupportTicketRepository } from '@phub/database';
import { runFairTenantCycle, type TenantCycleResult } from './tenant-cycle-orchestrator.js';

export type SupportTicketAutoclosePort = Pick<
  SupportTicketRepository,
  'closeResolvedBatch' | 'purgeClosedBatch'
>;
/** Row locks serialize replies and close; a reply using a stale version must refresh before resubmission. */
export async function runSupportTicketAutocloseBatch(input: {
  readonly repository: Pick<SupportTicketRepository, 'closeResolvedBatch'>;
  readonly tenantId: string;
  readonly limit: number;
  readonly correlationId: string;
}): Promise<number> {
  return input.repository.closeResolvedBatch({
    tenantId: input.tenantId,
    limit: input.limit,
    correlationId: input.correlationId,
  });
}
export async function runSupportTicketAutocloseTenantCycle(input: {
  readonly repository: SupportTicketAutoclosePort;
  readonly tenants: readonly { readonly id: string }[];
  readonly startOffset: number;
  readonly limit: number;
  readonly correlationId: () => string;
  readonly onTenantFailure: (tenant: { readonly id: string }, error: unknown) => void;
  readonly onProgress: () => void;
  readonly shouldStop: () => boolean;
}): Promise<TenantCycleResult & { readonly closed: number; readonly purged: number }> {
  let closed = 0;
  let purged = 0;
  const cycle = await runFairTenantCycle({
    tenants: input.tenants,
    startOffset: input.startOffset,
    shouldStop: input.shouldStop,
    runTenant: async (tenant) => {
      closed += await runSupportTicketAutocloseBatch({
        repository: input.repository,
        tenantId: tenant.id,
        limit: input.limit,
        correlationId: input.correlationId(),
      });
      purged += await input.repository.purgeClosedBatch({
        tenantId: tenant.id,
        limit: input.limit,
        correlationId: input.correlationId(),
      });
    },
    onTenantFailure: input.onTenantFailure,
    onProgress: input.onProgress,
  });
  return { ...cycle, closed, purged };
}
