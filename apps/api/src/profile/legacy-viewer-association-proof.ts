import type { LegacyGameSourceSnapshot } from '@phub/legacy-games-adapter';

export type LegacyViewerAssociationProofOutcome =
  | 'absent'
  | 'tenant_mismatch'
  | 'no_pending'
  | 'no_match'
  | 'not_deliverable'
  | 'delivered'
  | 'unavailable';

export interface LegacyViewerAssociationProofSource {
  /** Reads only the legacy games whose participant phone equals the authenticated viewer's phone. */
  readByViewerPhone(input: {
    readonly phoneE164: string;
    readonly limit: number;
  }): Promise<readonly LegacyGameSourceSnapshot[]>;
}

export interface LegacyViewerAssociationProofDelivery {
  hasPendingDeferredRequests(tenantId: string): Promise<boolean>;
  deliverDeferredFriendRequestsForPlayerKeys(input: {
    readonly tenantId: string;
    readonly deliveryUserId: string;
    readonly sourcePlayerAssociationIds: readonly string[];
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<{ readonly delivered: number; readonly pending: number }>;
}

const PROOF_READ_LIMIT = 20;
const PROOF_DELIVERY_LIMIT = 20;

/**
 * Resolves which one-way legacy player keys belong to a live PadlHub account from the phone the
 * provider asserts for that account, and delivers the friend requests saved against those imported
 * player rows (`profile.deferred_friend_requests`).
 *
 * The proof is deliberately *delivery-only*: the phone comes from our own client and the provider
 * denies server reads, so nothing here may become a durable identity binding. It only routes a saved
 * friend request to the account that proved the phone; it never writes
 * `integration.legacy_game_player_bindings` and can therefore never re-point an imported player, a
 * roster or a participation. The phone itself never leaves this boundary: the source matches it in
 * memory and only the pseudonymous player key crosses back.
 *
 * A provider or database failure yields `unavailable` and changes nothing; the next app entry that
 * posts the phone retries.
 */
export class LegacyViewerAssociationProof {
  public constructor(
    private readonly options: {
      readonly source: LegacyViewerAssociationProofSource;
      readonly delivery: LegacyViewerAssociationProofDelivery;
      readonly legacyTenantKey: string | undefined;
      readonly limit?: number;
      readonly onOutcome?: (
        outcome: LegacyViewerAssociationProofOutcome,
        context: {
          readonly tenantId: string;
          readonly userId: string;
          readonly delivered: number;
        },
      ) => void;
    },
  ) {}

  public async prove(input: {
    readonly tenantKey: string | undefined;
    readonly tenantId: string;
    readonly userId: string;
    readonly phoneE164: string | undefined;
    readonly correlationId: string;
  }): Promise<LegacyViewerAssociationProofOutcome> {
    const phoneE164 = input.phoneE164?.trim();
    if (!phoneE164) return this.report('absent', input, 0);
    if (!this.options.legacyTenantKey || input.tenantKey !== this.options.legacyTenantKey) {
      // The legacy mirror belongs to one configured tenant; another tenant may not claim its keys.
      return this.report('tenant_mismatch', input, 0);
    }
    try {
      if (!(await this.options.delivery.hasPendingDeferredRequests(input.tenantId))) {
        return this.report('no_pending', input, 0);
      }
      const snapshots = await this.options.source.readByViewerPhone({
        phoneE164,
        limit: this.options.limit ?? PROOF_READ_LIMIT,
      });
      const sourcePlayerAssociationIds = [
        ...new Set(
          snapshots
            .map((snapshot) => snapshot.viewerParticipantExternalId ?? '')
            .filter((association) => Boolean(association)),
        ),
      ];
      if (sourcePlayerAssociationIds.length === 0) return this.report('no_match', input, 0);
      const result = await this.options.delivery.deliverDeferredFriendRequestsForPlayerKeys({
        tenantId: input.tenantId,
        deliveryUserId: input.userId,
        sourcePlayerAssociationIds,
        limit: PROOF_DELIVERY_LIMIT,
        correlationId: input.correlationId,
      });
      return this.report(
        result.delivered > 0 ? 'delivered' : 'not_deliverable',
        input,
        result.delivered,
      );
    } catch {
      return this.report('unavailable', input, 0);
    }
  }

  private report(
    outcome: LegacyViewerAssociationProofOutcome,
    input: { readonly tenantId: string; readonly userId: string },
    delivered: number,
  ): LegacyViewerAssociationProofOutcome {
    try {
      this.options.onOutcome?.(outcome, {
        tenantId: input.tenantId,
        userId: input.userId,
        delivered,
      });
    } catch {
      // Telemetry must never change the link outcome.
    }
    return outcome;
  }
}
