/**
 * ADR 0029 D5: one bounded, best-effort sync of the authenticated user's `VIVA/subscription`
 * mappings. The Viva client id comes only from the user's synced `viva_profile` mapping; the
 * provider read is the server Viva Admin subscriptions method (never End User, ADR 0023).
 *
 * Every failure is reported as an outcome label and writes nothing. A read that names another
 * client for any instance is refused as a whole (`ownership_conflict`).
 */
export type VivaSubscriptionMappingSyncOutcome =
  | 'synced'
  | 'synced_with_conflicts'
  | 'unmapped'
  | 'profile_changed'
  | 'ownership_conflict'
  | 'unavailable';

export interface VivaSubscriptionMappingSyncDependencies {
  readonly readProfile: (input: {
    readonly tenantId: string;
    readonly userId: string;
  }) => Promise<{ readonly profileMappingId: string; readonly providerClientId: string } | null>;
  readonly readSubscriptions: (input: {
    readonly providerClientId: string;
    readonly correlationId: string;
  }) => Promise<{
    readonly providerSubscriptionIds: readonly string[];
    readonly observedAt: string;
  }>;
  readonly record: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly profileMappingId: string;
    readonly providerClientId: string;
    readonly providerSubscriptionIds: readonly string[];
    readonly observedAt: string;
    readonly correlationId: string;
  }) => Promise<{ readonly outcome: 'synced' | 'profile_changed'; readonly conflicts: number }>;
  /** Recognizes the adapter's whole-read ownership refusal without importing the adapter here. */
  readonly isOwnershipConflict: (error: unknown) => boolean;
}

export function createVivaSubscriptionMappingSync(deps: VivaSubscriptionMappingSyncDependencies) {
  return async (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<VivaSubscriptionMappingSyncOutcome> => {
    try {
      const profile = await deps.readProfile({ tenantId: input.tenantId, userId: input.userId });
      if (!profile) return 'unmapped';
      const read = await deps.readSubscriptions({
        providerClientId: profile.providerClientId,
        correlationId: input.correlationId,
      });
      const result = await deps.record({
        tenantId: input.tenantId,
        userId: input.userId,
        profileMappingId: profile.profileMappingId,
        providerClientId: profile.providerClientId,
        providerSubscriptionIds: read.providerSubscriptionIds,
        observedAt: read.observedAt,
        correlationId: input.correlationId,
      });
      if (result.outcome === 'profile_changed') return 'profile_changed';
      return result.conflicts > 0 ? 'synced_with_conflicts' : 'synced';
    } catch (error) {
      return deps.isOwnershipConflict(error) ? 'ownership_conflict' : 'unavailable';
    }
  };
}
