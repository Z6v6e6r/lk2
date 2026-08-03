export interface TenantCycleItem {
  readonly id: string;
}

export interface TenantCycleResult {
  readonly attemptedCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly interrupted: boolean;
  readonly nextStartOffset: number;
}

function normalizeOffset(offset: number, length: number): number {
  if (length === 0) return 0;
  return ((offset % length) + length) % length;
}

export function rotateTenantCycle<TTenant extends TenantCycleItem>(
  tenants: readonly TTenant[],
  startOffset: number,
): readonly TTenant[] {
  if (tenants.length < 2) return [...tenants];
  const normalizedOffset = normalizeOffset(startOffset, tenants.length);
  return [...tenants.slice(normalizedOffset), ...tenants.slice(0, normalizedOffset)];
}

export async function runFairTenantCycle<TTenant extends TenantCycleItem>(options: {
  readonly tenants: readonly TTenant[];
  readonly startOffset: number;
  readonly runTenant: (tenant: TTenant) => Promise<void>;
  readonly onTenantFailure: (tenant: TTenant, error: unknown) => void;
  readonly onProgress: () => void;
  readonly shouldStop?: () => boolean;
}): Promise<TenantCycleResult> {
  const orderedTenants = rotateTenantCycle(options.tenants, options.startOffset);
  let attemptedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let interrupted = false;

  for (const tenant of orderedTenants) {
    if (options.shouldStop?.()) {
      interrupted = true;
      break;
    }
    attemptedCount += 1;
    try {
      await options.runTenant(tenant);
      succeededCount += 1;
    } catch (error) {
      failedCount += 1;
      options.onTenantFailure(tenant, error);
    } finally {
      options.onProgress();
    }
  }

  const normalizedStartOffset = normalizeOffset(options.startOffset, options.tenants.length);
  return {
    attemptedCount,
    succeededCount,
    failedCount,
    interrupted,
    nextStartOffset:
      options.tenants.length === 0 ? 0 : (normalizedStartOffset + 1) % options.tenants.length,
  };
}
