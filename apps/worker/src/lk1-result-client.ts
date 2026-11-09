import type { Lk1ResultHandoff } from '@phub/database';

import type { Lk1Score } from './lk1-result-score.js';

export interface Lk1ResultClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export type Lk1ResultImportOutcome = 'applied' | 'duplicate' | 'rejected';

/** Stable, non-PII rejection reasons surfaced by the LK1 import endpoint. */
const REJECTION_CODES = new Set([
  'LK1_GAME_NOT_FOUND',
  'LK1_GAME_ARCHIVED',
  'LK1_SUBMITTER_NOT_FOUND',
  'LK1_SUBMITTER_NOT_PARTICIPANT',
  'LK1_RESULT_PAYLOAD_INVALID',
]);

/**
 * Publishes one confirmed LK2 result to LK1, which stays the owner of its own game records and its
 * rating recalculation. The idempotency key binds the exact result revision, so a retried delivery
 * after a lost response replays the same request and LK1 answers with its stored document.
 */
export class Lk1ResultClient {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  public constructor(options: Lk1ResultClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#serviceToken = options.serviceToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  public async importConfirmedResult(input: {
    readonly handoff: Lk1ResultHandoff;
    readonly score: Lk1Score;
    readonly correlationId: string;
  }): Promise<Lk1ResultImportOutcome> {
    const { handoff, score } = input;
    const response = await this.#fetch(`${this.#baseUrl}/lk-bridge/api/v1/game-results/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#serviceToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `game-result:${handoff.resultId}:v${handoff.resultRevision}`,
        'X-Correlation-ID': input.correlationId,
      },
      body: JSON.stringify({
        gameId: handoff.lk1GameId,
        externalResultId: handoff.resultId,
        externalResultRevision: handoff.resultRevision,
        submitterPhone: handoff.submitterPhoneE164,
        scoreA: score.scoreA,
        scoreB: score.scoreB,
        confirmedAt: handoff.confirmedAt,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 200 || response.status === 202) return 'applied';
    if (response.status === 409) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      const code =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { readonly code?: unknown }).code
          : undefined;
      if (code === 'LK1_RESULT_ALREADY_IMPORTED') return 'duplicate';
      throw new Error('LK1_RESULT_IDEMPOTENCY_CONFLICT');
    }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429
    ) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      const code =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { readonly code?: unknown }).code
          : undefined;
      if (typeof code === 'string' && REJECTION_CODES.has(code)) return 'rejected';
      throw new Error(`LK1_RESULT_REJECTED_${response.status}`);
    }
    throw new Error(`LK1_RESULT_HTTP_${response.status}`);
  }
}
