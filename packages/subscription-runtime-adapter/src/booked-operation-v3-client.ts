import {
  BOOKED_OPERATION_V3_ADMISSION_PATH,
  BOOKED_OPERATION_V3_CANCEL_PREFIX,
  BOOKED_OPERATION_V3_PREFLIGHT_PATH,
  BOOKED_OPERATION_V3_READ_PREFIX,
  parseBookedOperationV3CancelResult,
  parseBookedOperationV3PreflightResult,
  parseBookedOperationV3ReadOutcome,
  type BookedOperationV3AdmissionRequest,
  type BookedOperationV3CancelRequest,
  type BookedOperationV3CancelResult,
  type BookedOperationV3PreflightRequest,
  type BookedOperationV3PreflightResult,
  type BookedOperationV3ReadOutcome,
} from './booked-operation-v3.js';

export interface BookedOperationV3Envelope {
  readonly actorDelegation: string;
  readonly correlationId: string;
  readonly operationId: string;
  readonly actorToken?: { readonly token: string; readonly expiresAt: string };
}

export class BookedOperationV3ClientError extends Error {
  public constructor(public readonly status: number) {
    super('BOOKED_OPERATION_V3_OWNER_UNAVAILABLE');
  }
}

/**
 * Source-only client for the v3 receiver. It is not composed by the API: v3 requires the LK1
 * receiver, settlement and cancel scopes to be published first.
 */
export class BookedOperationV3Client {
  private readonly options: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly fetchImplementation?: typeof fetch;
    readonly circuitFailureThreshold?: number;
    readonly circuitResetMs?: number;
  };
  private failures = 0;
  private openUntil = 0;

  public constructor(options: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly fetchImplementation?: typeof fetch;
    readonly circuitFailureThreshold?: number;
    readonly circuitResetMs?: number;
  }) {
    const base = new URL(options.baseUrl);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    )
      throw new BookedOperationV3ClientError(503);
    this.options = options;
  }

  async preflight(
    request: BookedOperationV3PreflightRequest,
    envelope: BookedOperationV3Envelope,
  ): Promise<BookedOperationV3PreflightResult> {
    return parseBookedOperationV3PreflightResult(
      await this.send(BOOKED_OPERATION_V3_PREFLIGHT_PATH, 'POST', envelope, request, true),
    );
  }

  async admit(
    request: BookedOperationV3AdmissionRequest,
    envelope: BookedOperationV3Envelope,
  ): Promise<BookedOperationV3ReadOutcome> {
    return parseBookedOperationV3ReadOutcome(
      await this.send(BOOKED_OPERATION_V3_ADMISSION_PATH, 'POST', envelope, request, true),
    );
  }

  async read(
    operationId: string,
    envelope: BookedOperationV3Envelope,
  ): Promise<BookedOperationV3ReadOutcome> {
    return parseBookedOperationV3ReadOutcome(
      await this.send(
        BOOKED_OPERATION_V3_READ_PREFIX + operationId,
        'GET',
        { ...envelope, operationId },
        undefined,
        false,
      ),
    );
  }

  async cancel(
    request: BookedOperationV3CancelRequest,
    envelope: BookedOperationV3Envelope,
  ): Promise<BookedOperationV3CancelResult> {
    return parseBookedOperationV3CancelResult(
      await this.send(
        BOOKED_OPERATION_V3_CANCEL_PREFIX + request.operationId + '/cancel',
        'POST',
        { ...envelope, operationId: request.operationId },
        request,
        true,
      ),
    );
  }

  private async send(
    path: string,
    method: 'POST' | 'GET',
    envelope: BookedOperationV3Envelope,
    body: unknown,
    requireActorToken: boolean,
  ): Promise<unknown> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        envelope.operationId,
      ) ||
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId) ||
      (requireActorToken &&
        (!envelope.actorToken ||
          !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
          !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
          Date.parse(envelope.actorToken.expiresAt) <= Date.now()))
    )
      throw new BookedOperationV3ClientError(400);
    if (Date.now() < this.openUntil) throw new BookedOperationV3ClientError(503);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const url = new URL(path, this.options.baseUrl).href;
      const response = await (this.options.fetchImplementation ?? fetch)(url, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Subscription-Actor-Delegation': envelope.actorDelegation,
          'X-Correlation-ID': envelope.correlationId,
          ...(method === 'POST' && envelope.actorToken
            ? { 'X-Subscription-Actor-Token': envelope.actorToken.token }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || (response.url && response.url !== url)) {
        await response.body?.cancel();
        throw new BookedOperationV3ClientError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BookedOperationV3ClientError(503);
      let bytes = 0;
      let text = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32768) {
            await reader.cancel();
            throw new BookedOperationV3ClientError(503);
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      const parsed: unknown = JSON.parse(text);
      this.failures = 0;
      this.openUntil = 0;
      return parsed;
    } catch (error) {
      if (error instanceof BookedOperationV3ClientError) throw error;
      this.failures += 1;
      if (this.failures >= (this.options.circuitFailureThreshold ?? 3)) {
        this.openUntil = Date.now() + (this.options.circuitResetMs ?? 30_000);
        this.failures = 0;
      }
      throw new BookedOperationV3ClientError(503);
    } finally {
      clearTimeout(timer);
    }
  }
}
