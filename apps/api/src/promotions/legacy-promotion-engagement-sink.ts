import type { PromotionEngagementPlacement } from '@phub/database';

export interface PromotionEngagementSinkInput {
  readonly eventId: string;
  readonly placement: PromotionEngagementPlacement;
  readonly adId: string;
  readonly kind: 'IMPRESSION' | 'CLICK';
  readonly phoneE164?: string;
  readonly occurredAt: string;
  readonly correlationId: string;
}

export interface PromotionEngagementSink {
  record(input: PromotionEngagementSinkInput): Promise<void>;
}

export interface PromotionEngagementSinkMetric {
  readonly outcome: 'success' | 'failure';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: string;
}

export class LegacyPromotionEngagementSink implements PromotionEngagementSink {
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly secret: string;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly circuitFailureThreshold: number;
      readonly circuitResetMs: number;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (metric: PromotionEngagementSinkMetric) => void;
    },
  ) {}

  public async record(input: PromotionEngagementSinkInput): Promise<void> {
    if (
      this.circuitOpenedAt > 0 &&
      Date.now() - this.circuitOpenedAt < this.options.circuitResetMs
    ) {
      throw new Error('PROMOTION_ENGAGEMENT_CIRCUIT_OPEN');
    }
    const fetchImplementation =
      this.options.fetchImplementation ?? ((request, init) => globalThis.fetch(request, init));
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetchImplementation(
          new URL('/api/advertising/engagements', this.options.baseUrl),
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Advertising-Event-Key': this.options.secret,
              'X-Correlation-ID': input.correlationId,
            },
            body: JSON.stringify({
              eventId: input.eventId,
              placement: input.placement,
              adId: input.adId,
              kind: input.kind,
              ...(input.phoneE164 ? { phoneE164: input.phoneE164 } : {}),
              occurredAt: input.occurredAt,
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          const error = new Error(`PROMOTION_ENGAGEMENT_HTTP_${response.status}`);
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
          this.options.onMetric?.({
            outcome: 'failure',
            attempt,
            durationMs: Date.now() - startedAt,
            status: response.status,
            code: error.message,
          });
          continue;
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = 0;
        this.options.onMetric?.({
          outcome: 'success',
          attempt,
          durationMs: Date.now() - startedAt,
          status: response.status,
        });
        return;
      } catch (error) {
        lastError = error;
        const code =
          error instanceof Error && error.name === 'AbortError'
            ? 'PROMOTION_ENGAGEMENT_TIMEOUT'
            : error instanceof Error
              ? error.message
              : 'PROMOTION_ENGAGEMENT_UNAVAILABLE';
        this.options.onMetric?.({
          outcome: 'failure',
          attempt,
          durationMs: Date.now() - startedAt,
          code,
        });
        if (/^PROMOTION_ENGAGEMENT_HTTP_4\d\d$/.test(code)) break;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.circuitFailureThreshold) {
      this.circuitOpenedAt = Date.now();
    }
    throw new Error('PROMOTION_ENGAGEMENT_UNAVAILABLE', { cause: lastError });
  }
}
