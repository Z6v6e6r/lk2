import type { ConfirmedGameResultProjection } from '@phub/database';

export interface CupRatingClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class CupRatingClient {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  public constructor(options: CupRatingClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#serviceToken = options.serviceToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  public async applyConfirmedResult(
    result: ConfirmedGameResultProjection,
    correlationId: string,
  ): Promise<'applied' | 'duplicate'> {
    const response = await this.#fetch(
      `${this.#baseUrl}/internal/api/v1/game-results/${result.resultId}/apply-rating`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#serviceToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `game-result:${result.resultId}:v${result.resultRevision}`,
          'X-Correlation-ID': correlationId,
        },
        body: JSON.stringify({
          source: 'GAME_RESULT_CONFIRMED',
          tenantId: result.tenantId,
          gameId: result.gameId,
          resultId: result.resultId,
          resultRevision: result.resultRevision,
          gameKind: result.kind,
          occurredAt: result.endsAt,
          participantUserIds: result.participantUserIds,
          sets: result.sets,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (response.status === 409) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { readonly code?: unknown }).code === 'CUP_RATING_ALREADY_APPLIED'
      ) {
        return 'duplicate';
      }
      throw new Error('CUP_RATING_IDEMPOTENCY_CONFLICT');
    }
    if (response.status === 200 || response.status === 202) return 'applied';
    throw new Error(`CUP_RATING_HTTP_${response.status}`);
  }
}
