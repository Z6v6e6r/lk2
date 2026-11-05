import type { ProfileSummaryRepository } from '@phub/database';
import { VivaResidencySourceError, type VivaResidencyObservation } from '@phub/viva-adapter';

import { stableProfilePhotoUrl } from '../profile/profile-photo-url.js';

export type ClientResidencyState = 'ACTIVE' | 'NONE' | 'UNAVAILABLE';

export type ClientResidencyUnavailableReason =
  | 'PRODUCT_NOT_CONFIGURED'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SOURCE_DISABLED'
  | 'IDENTITY_MAPPING_MISSING'
  | 'IDENTITY_RESOLUTION_UNAVAILABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_RESPONSE_INVALID'
  | 'SOURCE_PARTIAL'
  | 'PRODUCT_IDENTITY_MISSING'
  | 'OWNERSHIP_CONFLICT'
  | 'CIRCUIT_OPEN';

export interface ClientResidencyHolder {
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/**
 * The single answer this slice exposes: does the verified user hold an active
 * instance of the configured residency product, and how fresh is that answer?
 * NONE means a complete provider read proved absence; UNAVAILABLE means no
 * trustworthy conclusion could be made.
 */
export interface ClientResidencyStatus {
  readonly state: ClientResidencyState;
  /** First day the matched residency instance is valid, or null when the provider omits it. */
  readonly validFrom: string | null;
  /** Last day the matched (or most recent) residency instance is valid. */
  readonly validUntil: string | null;
  /** Timestamp of the last complete provider read; null when no trusted read happened. */
  readonly checkedAt: string | null;
  readonly unavailableReason: ClientResidencyUnavailableReason | null;
  /** Reused PadlHub profile presentation; never a Viva payload. */
  readonly holder: ClientResidencyHolder | null;
}

export interface ClientResidencySource {
  read(input: {
    readonly providerClientId: string;
    readonly correlationId: string;
  }): Promise<VivaResidencyObservation>;
}

export type ClientResidencyMetric = {
  readonly operation: 'client_residency';
  readonly state: ClientResidencyState;
  readonly reason?: ClientResidencyUnavailableReason;
  readonly durationMs: number;
};

export interface ClientResidencyServiceOptions {
  readonly productConfigured: boolean;
  readonly source?: ClientResidencySource;
  readonly sourceUnavailableReason?: 'SOURCE_DISABLED' | 'SOURCE_NOT_CONFIGURED';
  readonly resolveVivaClientId: (input: {
    readonly tenantId: string;
    readonly userId: string;
  }) => Promise<string | undefined>;
  readonly profileRepository?: Pick<ProfileSummaryRepository, 'get'>;
  readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
  readonly now?: () => number;
  readonly onMetric?: (metric: ClientResidencyMetric) => void;
}

const SOURCE_ERROR_REASONS: Readonly<
  Record<VivaResidencySourceError['code'], ClientResidencyUnavailableReason>
> = {
  RESIDENCY_PRODUCT_NOT_CONFIGURED: 'PRODUCT_NOT_CONFIGURED',
  RESIDENCY_SOURCE_DISABLED: 'SOURCE_DISABLED',
  RESIDENCY_SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  RESIDENCY_SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  RESIDENCY_SOURCE_RESPONSE_INVALID: 'SOURCE_RESPONSE_INVALID',
  RESIDENCY_SOURCE_PARTIAL: 'SOURCE_PARTIAL',
  RESIDENCY_PRODUCT_IDENTITY_MISSING: 'PRODUCT_IDENTITY_MISSING',
  RESIDENCY_OWNERSHIP_CONFLICT: 'OWNERSHIP_CONFLICT',
  RESIDENCY_CIRCUIT_OPEN: 'CIRCUIT_OPEN',
};

export class ClientResidencyService {
  private readonly now: () => number;

  public constructor(private readonly options: ClientResidencyServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private emit(metric: ClientResidencyMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change residency behavior.
    }
  }

  private async loadHolder(
    tenantId: string,
    userId: string,
  ): Promise<ClientResidencyHolder | null> {
    const summary = await this.options.profileRepository?.get(tenantId, userId);
    if (!summary) return null;
    const deliveryIds = this.options.photoRepository
      ? await this.options.photoRepository.getPhotoDeliveryIds(tenantId, [userId])
      : new Map<string, string>();
    const avatarUrl = stableProfilePhotoUrl({
      tenantId,
      userId,
      currentUrl: summary.avatarUrl,
      deliveryIds,
    });
    return {
      displayName: summary.displayName,
      avatarUrl: typeof avatarUrl === 'string' && avatarUrl.length > 0 ? avatarUrl : null,
    };
  }

  private unavailable(
    holder: ClientResidencyHolder | null,
    reason: ClientResidencyUnavailableReason,
  ): ClientResidencyStatus {
    return {
      state: 'UNAVAILABLE',
      validFrom: null,
      validUntil: null,
      checkedAt: null,
      unavailableReason: reason,
      holder,
    };
  }

  public async getClientResidency(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<ClientResidencyStatus> {
    const startedAt = this.now();
    const holder = await this.loadHolder(input.tenantId, input.userId).catch(() => null);
    const finish = (status: ClientResidencyStatus): ClientResidencyStatus => {
      this.emit({
        operation: 'client_residency',
        state: status.state,
        ...(status.unavailableReason ? { reason: status.unavailableReason } : {}),
        durationMs: Math.max(0, this.now() - startedAt),
      });
      return status;
    };

    if (!this.options.productConfigured) {
      return finish(this.unavailable(holder, 'PRODUCT_NOT_CONFIGURED'));
    }
    if (!this.options.source) {
      return finish(
        this.unavailable(holder, this.options.sourceUnavailableReason ?? 'SOURCE_NOT_CONFIGURED'),
      );
    }

    let providerClientId: string | undefined;
    try {
      providerClientId = await this.options.resolveVivaClientId({
        tenantId: input.tenantId,
        userId: input.userId,
      });
    } catch {
      return finish(this.unavailable(holder, 'IDENTITY_RESOLUTION_UNAVAILABLE'));
    }
    if (!providerClientId) {
      return finish(this.unavailable(holder, 'IDENTITY_MAPPING_MISSING'));
    }

    try {
      const observation = await this.options.source.read({
        providerClientId,
        correlationId: input.correlationId,
      });
      return finish({
        state: observation.active ? 'ACTIVE' : 'NONE',
        validFrom: observation.validFrom,
        validUntil: observation.validUntil,
        checkedAt: observation.checkedAt,
        unavailableReason: null,
        holder,
      });
    } catch (error) {
      const reason =
        error instanceof VivaResidencySourceError
          ? SOURCE_ERROR_REASONS[error.code]
          : 'SOURCE_UNAVAILABLE';
      return finish(this.unavailable(holder, reason));
    }
  }
}
