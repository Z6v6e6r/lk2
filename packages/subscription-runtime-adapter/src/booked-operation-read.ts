export const BOOKED_OPERATION_READ_PREFIX = '/lk/integrations/v1/booked-operations/';
export const BOOKED_OPERATION_READ_SCOPE = 'subscription-runtime.booked-operation.read';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface BookedOperationReadOutcome {
  readonly contractVersion: 1;
  readonly operationId: string;
  readonly status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED';
  readonly asOf: string | null;
  readonly reason: 'OWNER_PENDING' | 'RECONCILIATION_REQUIRED' | 'OWNER_BOOKING_CONFIRMED';
}

export class BookedOperationReadError extends Error {
  constructor(public readonly status: number) {
    super('BOOKED_OPERATION_READ_UNAVAILABLE');
  }
}

export function parseBookedOperationReadOutcome(
  value: unknown,
  operationId: string,
): BookedOperationReadOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BookedOperationReadError(503);
  const row = value as Record<string, unknown>;
  const expectedReason = {
    PENDING: 'OWNER_PENDING',
    UNKNOWN: 'RECONCILIATION_REQUIRED',
    CONFIRMED: 'OWNER_BOOKING_CONFIRMED',
  };
  const validTime =
    typeof row.asOf === 'string' &&
    Number.isFinite(Date.parse(row.asOf)) &&
    new Date(row.asOf).toISOString() === row.asOf;
  if (
    Object.keys(row).sort().join(',') !== 'asOf,contractVersion,operationId,reason,status' ||
    row.contractVersion !== 1 ||
    row.operationId !== operationId ||
    !uuidPattern.test(operationId) ||
    typeof row.status !== 'string' ||
    !Object.hasOwn(expectedReason, row.status) ||
    row.reason !== expectedReason[row.status as keyof typeof expectedReason] ||
    (!validTime && !(row.status === 'UNKNOWN' && row.asOf === null))
  ) {
    throw new BookedOperationReadError(503);
  }
  return row as unknown as BookedOperationReadOutcome;
}

// Dedicated LK1 owner URL: never reuse the advisory quote recipient or a write router.
export class BookedOperationReadClient {
  private failures = 0;
  private failureVersion = 0;
  private openUntil = 0;
  private probeInFlight = false;
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly environment: 'development' | 'production';
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (outcome: 'success' | 'not_found' | 'failure' | 'circuit_open') => void;
    },
  ) {
    const url = new URL(options.baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(options.environment === 'development' && loopback && url.protocol === 'http:')) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    ) {
      throw new BookedOperationReadError(503);
    }
  }

  async read(
    operationId: string,
    envelope: { actorDelegation: string; correlationId: string },
  ): Promise<BookedOperationReadOutcome> {
    if (
      !uuidPattern.test(operationId) ||
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId)
    )
      throw new BookedOperationReadError(503);
    if (this.openUntil > Date.now() || this.probeInFlight) {
      this.emit('circuit_open');
      throw new BookedOperationReadError(503);
    }
    const halfOpen = this.openUntil > 0;
    const failureVersion = this.failureVersion;
    if (halfOpen) this.probeInFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await (this.options.fetchImplementation ?? fetch)(
        new URL(BOOKED_OPERATION_READ_PREFIX + operationId, this.options.baseUrl),
        {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'X-Subscription-Actor-Delegation': envelope.actorDelegation,
            'X-Correlation-ID': envelope.correlationId,
          },
        },
      );
      if (!response.ok) await response.body?.cancel();
      if (response.status === 404) {
        this.resetIfUnchanged(failureVersion);
        this.emit('not_found');
        throw new BookedOperationReadError(404);
      }
      if (!response.ok) throw new BookedOperationReadError(503);
      // A hostile/error response cannot grow memory without bound. Never log raw receipts.
      const reader = response.body?.getReader();
      if (!reader) throw new BookedOperationReadError(503);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 2048) throw new BookedOperationReadError(503);
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const outcome = parseBookedOperationReadOutcome(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        operationId,
      );
      this.resetIfUnchanged(failureVersion);
      this.emit('success');
      return outcome;
    } catch (error) {
      if (error instanceof BookedOperationReadError && error.status === 404) throw error;
      this.failures += 1;
      this.failureVersion += 1;
      if (halfOpen || this.failures >= 3) this.openUntil = Date.now() + 10_000;
      this.emit('failure');
      throw new BookedOperationReadError(503);
    } finally {
      clearTimeout(timeout);
      if (halfOpen) this.probeInFlight = false;
    }
  }

  private emit(outcome: 'success' | 'not_found' | 'failure' | 'circuit_open'): void {
    try {
      this.options.onMetric?.(outcome);
    } catch {
      /* Telemetry cannot change read behavior. */
    }
  }

  private resetIfUnchanged(version: number): void {
    if (version !== this.failureVersion) return;
    this.failures = 0;
    this.openUntil = 0;
  }
}
