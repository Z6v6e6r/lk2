/**
 * Version-neutral contract for the single cluster-wide DDL fence.
 *
 * The V2 canonical host and the V3 durable preparation host deliberately use
 * this same advisory key and lease shape.  A versioned host must therefore not
 * create a parallel lock namespace.
 */
export const COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY =
  'phub.communities.role-split.restore.v1' as const;

export interface CommunitiesStagingRoleSplitDdlFence {
  acquire(input: {
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }>;
  assertHeld(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void>;
  release(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void>;
}

export type CommunitiesStagingRoleSplitDdlFenceLease = Awaited<
  ReturnType<CommunitiesStagingRoleSplitDdlFence['acquire']>
>;
