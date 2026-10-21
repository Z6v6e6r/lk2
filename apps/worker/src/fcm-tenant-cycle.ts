import type { Pool } from 'pg';

import { runWebPushTenantCycle, type WebPushTenantCycleResult } from './web-push-tenant-cycle.js';

/** Fair tenant traversal is transport-neutral; this wrapper keeps FCM metrics and call sites distinct. */
export function runFcmTenantCycle(options: {
  readonly pool: Pool;
  readonly startOffset: number;
  readonly maxDeliveriesPerTenant: number;
  readonly shouldStop: () => boolean;
  readonly runTenant: (tenantId: string) => Promise<number>;
  readonly onTenantFailure: (tenantId: string, error: unknown) => void;
  readonly onProgress: () => void;
}): Promise<WebPushTenantCycleResult> {
  return runWebPushTenantCycle(options);
}
