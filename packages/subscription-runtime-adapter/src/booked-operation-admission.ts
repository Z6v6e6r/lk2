import { createHash } from 'node:crypto';

import {
  parseBookedOperationReadOutcome,
  type BookedOperationReadOutcome,
} from './booked-operation-read.js';

export const BOOKED_OPERATION_ADMISSION_PATH = '/lk/integrations/v1/booked-operation-admissions';
export const BOOKED_OPERATION_ADMISSION_SCOPE = 'subscription-runtime.booked-operation.admit';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface BookedOperationAdmissionRequest {
  readonly action: 'JOIN_GAME';
  readonly target: {
    readonly id: string;
    readonly expectedRevision: number;
  };
  readonly paymentIntent: 'USE_SUBSCRIPTION';
}
export function parseBookedOperationAdmissionRequest(
  value: unknown,
): BookedOperationAdmissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BookedOperationAdmissionError(400);
  const row = value as Record<string, unknown>;
  const target = row.target as Record<string, unknown> | undefined;
  if (
    Object.keys(row).sort().join() !== 'action,paymentIntent,target' ||
    row.action !== 'JOIN_GAME' ||
    row.paymentIntent !== 'USE_SUBSCRIPTION' ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    Object.keys(target).sort().join() !== 'expectedRevision,id' ||
    typeof target.id !== 'string' ||
    !uuid.test(target.id) ||
    !Number.isSafeInteger(target.expectedRevision) ||
    Number(target.expectedRevision) < 1
  )
    throw new BookedOperationAdmissionError(400);
  return {
    action: 'JOIN_GAME',
    target: {
      id: target.id,
      expectedRevision: Number(target.expectedRevision),
    },
    paymentIntent: 'USE_SUBSCRIPTION',
  };
}
export function bookedOperationAdmissionRequestSha256(
  value: BookedOperationAdmissionRequest,
): string {
  return `sha256:${createHash('sha256')
    .update(
      `booked-operation-admission:v1\0${JSON.stringify(parseBookedOperationAdmissionRequest(value))}`,
    )
    .digest('hex')}`;
}
// Identity-scoped, server-generated UUID; the owner checks the persisted immutable binding.
export function bookedOperationAdmissionId(
  tenantId: string,
  userId: string,
  keySha256: string,
): string {
  if (!uuid.test(tenantId) || !uuid.test(userId) || !/^sha256:[a-f0-9]{64}$/.test(keySha256))
    throw new BookedOperationAdmissionError(400);
  const chars = createHash('sha256')
    .update(`booked-operation-admission:v1\0lk2-api\0${tenantId}\0${userId}\0${keySha256}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class BookedOperationAdmissionError extends Error {
  constructor(public readonly status: number) {
    super('BOOKED_OPERATION_ADMISSION_UNAVAILABLE');
  }
}
export class BookedOperationAdmissionClient {
  private failures = 0;
  private openUntil = 0;
  private failureVersion = 0;
  private probeInFlight = false;
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly environment: 'development' | 'production';
      readonly timeoutMs: number;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (outcome: 'success' | 'failure' | 'conflict' | 'circuit_open') => void;
    },
  ) {
    const u = new URL(options.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      (u.protocol !== 'https:' &&
        !(
          options.environment === 'development' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
          u.protocol === 'http:'
        )) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    )
      throw new BookedOperationAdmissionError(503);
  }
  async admit(
    request: BookedOperationAdmissionRequest,
    envelope: { actorDelegation: string; correlationId: string; operationId: string },
  ): Promise<BookedOperationReadOutcome> {
    const body = parseBookedOperationAdmissionRequest(request);
    if (
      !uuid.test(envelope.operationId) ||
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId)
    )
      throw new BookedOperationAdmissionError(400);
    if (this.openUntil > Date.now() || this.probeInFlight) {
      this.metric('circuit_open');
      throw new BookedOperationAdmissionError(503);
    }
    const version = this.failureVersion;
    const halfOpen = this.openUntil !== 0;
    if (halfOpen) this.probeInFlight = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BookedOperationAdmissionError(503));
      }, this.options.timeoutMs);
    });
    const run = async () => {
      // No automatic write retry: a lost response is recovered only with the caller's same key.
      const response = await (this.options.fetchImplementation ?? fetch)(
        new URL(BOOKED_OPERATION_ADMISSION_PATH, this.options.baseUrl),
        {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': envelope.correlationId,
            'X-Subscription-Actor-Delegation': envelope.actorDelegation,
          },
          body: JSON.stringify(body),
        },
      );
      if (response.status === 409) {
        await response.body?.cancel();
        if (version === this.failureVersion) {
          this.failures = 0;
          this.openUntil = 0;
        }
        this.metric('conflict');
        throw new BookedOperationAdmissionError(409);
      }
      if (response.status !== 202) {
        await response.body?.cancel();
        throw new BookedOperationAdmissionError(503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BookedOperationAdmissionError(503);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const c = await reader.read();
          if (c.done) break;
          length += c.value.length;
          if (length > 2048) throw new BookedOperationAdmissionError(503);
          chunks.push(c.value);
        }
      } finally {
        await reader.cancel();
      }
      const outcome = parseBookedOperationReadOutcome(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        envelope.operationId,
      );
      if (outcome.status !== 'PENDING') throw new BookedOperationAdmissionError(503);
      if (version === this.failureVersion) {
        this.failures = 0;
        this.openUntil = 0;
      }
      this.metric('success');
      return outcome;
    };
    try {
      return await Promise.race([run(), deadline]);
    } catch (e) {
      if (e instanceof BookedOperationAdmissionError && e.status === 409) throw e;
      this.failureVersion++;
      this.failures++;
      if (this.failures >= 3) this.openUntil = Date.now() + 10_000;
      this.metric('failure');
      throw new BookedOperationAdmissionError(503);
    } finally {
      controller.abort();
      clearTimeout(timer!);
      if (halfOpen) this.probeInFlight = false;
    }
  }
  private metric(outcome: 'success' | 'failure' | 'conflict' | 'circuit_open'): void {
    try {
      this.options.onMetric?.(outcome);
    } catch {
      /* telemetry cannot change admission */
    }
  }
}
