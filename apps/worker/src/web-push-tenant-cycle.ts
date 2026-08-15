import type { Pool } from 'pg';

import { runFairTenantCycle } from './tenant-cycle-orchestrator.js';

export interface WebPushTenantCycleResult {
  readonly attemptedCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly interrupted: boolean;
  readonly nextStartOffset: number;
  readonly rounds: number;
}

export async function runWebPushTenantCycle(options: {
  readonly pool: Pool;
  readonly startOffset: number;
  readonly maxDeliveriesPerTenant: number;
  readonly shouldStop: () => boolean;
  readonly runTenant: (tenantId: string) => Promise<number>;
  readonly onTenantFailure: (tenantId: string, error: unknown) => void;
  readonly onProgress: () => void;
}): Promise<WebPushTenantCycleResult> {
  if (
    !Number.isInteger(options.maxDeliveriesPerTenant) ||
    options.maxDeliveriesPerTenant < 1 ||
    options.maxDeliveriesPerTenant > 100
  ) {
    throw new Error('WEB_PUSH_BATCH_SIZE_INVALID');
  }
  const tenants = await options.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true order by id',
  );
  if (tenants.rows.length === 0) {
    return {
      attemptedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      interrupted: false,
      nextStartOffset: 0,
      rounds: 0,
    };
  }

  let attemptedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let interrupted = false;
  let roundStartOffset = options.startOffset;
  let rounds = 0;
  const completedTenantIds = new Set<string>();

  while (rounds < options.maxDeliveriesPerTenant) {
    const activeTenants = tenants.rows.filter((tenant) => !completedTenantIds.has(tenant.id));
    if (activeTenants.length === 0) break;
    let claimedThisRound = 0;
    const round = await runFairTenantCycle({
      tenants: activeTenants,
      startOffset: roundStartOffset,
      shouldStop: options.shouldStop,
      runTenant: async (tenant) => {
        const claimed = await options.runTenant(tenant.id);
        if (!Number.isInteger(claimed) || claimed < 0 || claimed > 1) {
          throw new Error('WEB_PUSH_TENANT_CLAIM_COUNT_INVALID');
        }
        if (claimed === 0) completedTenantIds.add(tenant.id);
        claimedThisRound += claimed;
      },
      onTenantFailure: (tenant, error) => {
        completedTenantIds.add(tenant.id);
        options.onTenantFailure(tenant.id, error);
      },
      onProgress: options.onProgress,
    });
    rounds += 1;
    attemptedCount += round.attemptedCount;
    succeededCount += round.succeededCount;
    failedCount += round.failedCount;
    interrupted ||= round.interrupted;
    roundStartOffset = round.nextStartOffset;
    if (round.interrupted || claimedThisRound === 0) break;
  }

  return {
    attemptedCount,
    succeededCount,
    failedCount,
    interrupted,
    nextStartOffset:
      ((((options.startOffset % tenants.rows.length) + tenants.rows.length) % tenants.rows.length) +
        1) %
      tenants.rows.length,
    rounds,
  };
}
