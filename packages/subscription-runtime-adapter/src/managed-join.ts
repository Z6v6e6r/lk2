import { createHash } from 'node:crypto';
import {
  parseManagedJoinEntitlement,
  parseManagedJoinReceipt,
  type ManagedJoinEntitlement,
  type ManagedJoinReceipt,
} from '@phub/domain';
export {
  parseManagedJoinEntitlement,
  parseManagedJoinReceipt,
  parseManagedJoinBinding,
  managedJoinReceiptMatchesEntitlement,
  type ManagedJoinEntitlement,
  type ManagedJoinReceipt,
  type ManagedJoinBinding,
} from '@phub/domain';
export const MANAGED_JOIN_PREFLIGHT_PATH = '/lk/integrations/v2/booked-operation-preflights';
export const MANAGED_JOIN_ADMISSION_PATH = '/lk/integrations/v2/booked-operation-admissions';
export const MANAGED_JOIN_READ_PREFIX = '/lk/integrations/v2/booked-operations/';
export const MANAGED_JOIN_PREFLIGHT_SCOPE = 'subscription-runtime.booked-operation.preflight';
export interface ManagedJoinPreflightRequest {
  readonly contractVersion: 2;
  readonly action: 'JOIN_GAME';
  readonly target: { readonly id: string; readonly expectedRevision: number };
  readonly paymentIntent: 'USE_SUBSCRIPTION';
}
export interface ManagedJoinAdmissionRequest extends ManagedJoinPreflightRequest {
  readonly entitlement: ManagedJoinEntitlement;
}
export type ManagedJoinPreflightResult = {
  readonly contractVersion: 2;
  readonly nonBinding: true;
  readonly operationId: string;
  readonly action: 'JOIN_GAME';
  readonly target: ManagedJoinPreflightRequest['target'];
} & ({ readonly management: 'LEGACY' } | { readonly entitlement: ManagedJoinEntitlement });
export interface ManagedJoinReadOutcome {
  readonly contractVersion: 2;
  readonly operationId: string;
  readonly status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED';
  readonly asOf: string | null;
  readonly reason: 'OWNER_PENDING' | 'RECONCILIATION_REQUIRED' | 'OWNER_BOOKING_CONFIRMED';
  readonly receipt?: ManagedJoinReceipt;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const keys = (v: unknown, names: string): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === names.split(',').sort().join();
export class ManagedJoinOwnerError extends Error {
  constructor(public readonly status: number) {
    super('MANAGED_JOIN_OWNER_UNAVAILABLE');
  }
}
export function parseManagedJoinPreflightRequest(value: unknown): ManagedJoinPreflightRequest {
  if (
    !keys(value, 'contractVersion,action,target,paymentIntent') ||
    value.contractVersion !== 2 ||
    value.action !== 'JOIN_GAME' ||
    value.paymentIntent !== 'USE_SUBSCRIPTION' ||
    !keys(value.target, 'id,expectedRevision') ||
    !uuid(value.target.id) ||
    !Number.isSafeInteger(value.target.expectedRevision) ||
    Number(value.target.expectedRevision) < 1
  )
    throw new ManagedJoinOwnerError(400);
  return {
    contractVersion: 2,
    action: 'JOIN_GAME',
    target: { id: value.target.id, expectedRevision: Number(value.target.expectedRevision) },
    paymentIntent: 'USE_SUBSCRIPTION',
  };
}
export function parseManagedJoinAdmissionRequest(value: unknown): ManagedJoinAdmissionRequest {
  if (!keys(value, 'contractVersion,action,target,paymentIntent,entitlement'))
    throw new ManagedJoinOwnerError(400);
  const { entitlement, ...base } = value;
  return {
    ...parseManagedJoinPreflightRequest(base),
    entitlement: parseManagedJoinEntitlement(entitlement),
  };
}
export const managedJoinPreflightSha256 = (value: ManagedJoinPreflightRequest): string =>
  `sha256:${createHash('sha256')
    .update(
      'booked-operation-preflight:v2\0' + JSON.stringify(parseManagedJoinPreflightRequest(value)),
    )
    .digest('hex')}`;
export const managedJoinAdmissionSha256 = (value: ManagedJoinAdmissionRequest): string =>
  `sha256:${createHash('sha256')
    .update(
      'booked-operation-admission:v2\0' + JSON.stringify(parseManagedJoinAdmissionRequest(value)),
    )
    .digest('hex')}`;
export function parseManagedJoinPreflightResult(
  value: unknown,
  operationId: string,
  request: ManagedJoinPreflightRequest,
): ManagedJoinPreflightResult {
  const legacy =
    keys(value, 'contractVersion,nonBinding,operationId,action,target,management') &&
    value.management === 'LEGACY';
  if (
    (!legacy && !keys(value, 'contractVersion,nonBinding,operationId,action,target,entitlement')) ||
    !value ||
    typeof value !== 'object'
  )
    throw new ManagedJoinOwnerError(503);
  const r = value;
  if (
    r.contractVersion !== 2 ||
    r.nonBinding !== true ||
    r.operationId !== operationId ||
    !uuid(operationId) ||
    r.action !== 'JOIN_GAME' ||
    !keys(r.target, 'id,expectedRevision') ||
    r.target.id !== request.target.id ||
    r.target.expectedRevision !== request.target.expectedRevision
  )
    throw new ManagedJoinOwnerError(503);
  return {
    contractVersion: 2,
    nonBinding: true,
    operationId,
    action: 'JOIN_GAME',
    target: { ...request.target },
    ...(legacy
      ? { management: 'LEGACY' as const }
      : { entitlement: parseManagedJoinEntitlement(r.entitlement) }),
  };
}
export function parseManagedJoinReadOutcome(
  value: unknown,
  operationId: string,
): ManagedJoinReadOutcome {
  const r = value as Record<string, unknown> | null;
  const confirmed = r?.status === 'CONFIRMED';
  if (
    !keys(
      value,
      confirmed
        ? 'contractVersion,operationId,status,asOf,reason,receipt'
        : 'contractVersion,operationId,status,asOf,reason',
    ) ||
    value.contractVersion !== 2 ||
    value.operationId !== operationId ||
    !uuid(operationId) ||
    !['PENDING', 'UNKNOWN', 'CONFIRMED'].includes(String(value.status)) ||
    value.reason !==
      (
        {
          PENDING: 'OWNER_PENDING',
          UNKNOWN: 'RECONCILIATION_REQUIRED',
          CONFIRMED: 'OWNER_BOOKING_CONFIRMED',
        } as Record<string, string>
      )[String(value.status)] ||
    (!(value.status === 'UNKNOWN' && value.asOf === null) &&
      (typeof value.asOf !== 'string' ||
        !Number.isFinite(Date.parse(value.asOf)) ||
        new Date(value.asOf).toISOString() !== value.asOf))
  )
    throw new ManagedJoinOwnerError(503);
  if (confirmed && parseManagedJoinReceipt(value.receipt).operationId !== operationId)
    throw new ManagedJoinOwnerError(503);
  return structuredClone(value) as unknown as ManagedJoinReadOutcome;
}
type Envelope = {
  readonly actorDelegation: string;
  readonly correlationId: string;
  readonly operationId: string;
  readonly actorToken?: { readonly token: string; readonly expiresAt: string };
};
/** Three fixed owner routes, bounded response and no write retries. */
export class ManagedJoinOwnerClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly environment: 'development' | 'production';
      readonly timeoutMs: number;
      readonly fetchImplementation?: typeof fetch;
    },
  ) {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          options.environment === 'development' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    )
      throw new ManagedJoinOwnerError(503);
  }
  async preflight(
    request: ManagedJoinPreflightRequest,
    envelope: Envelope,
  ): Promise<ManagedJoinPreflightResult> {
    const body = parseManagedJoinPreflightRequest(request);
    return parseManagedJoinPreflightResult(
      await this.send(MANAGED_JOIN_PREFLIGHT_PATH, 'POST', envelope, body),
      envelope.operationId,
      body,
    );
  }
  async admit(
    request: ManagedJoinAdmissionRequest,
    envelope: Envelope,
  ): Promise<ManagedJoinReadOutcome> {
    return parseManagedJoinReadOutcome(
      await this.send(
        MANAGED_JOIN_ADMISSION_PATH,
        'POST',
        envelope,
        parseManagedJoinAdmissionRequest(request),
      ),
      envelope.operationId,
    );
  }
  async read(envelope: Envelope): Promise<ManagedJoinReadOutcome> {
    return parseManagedJoinReadOutcome(
      await this.send(MANAGED_JOIN_READ_PREFIX + envelope.operationId, 'GET', envelope),
      envelope.operationId,
    );
  }
  private async send(
    path: string,
    method: 'POST' | 'GET',
    envelope: Envelope,
    body?: unknown,
  ): Promise<unknown> {
    if (
      !uuid(envelope.operationId) ||
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId) ||
      (method === 'POST' &&
        (!envelope.actorToken ||
          !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
          !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
          Date.parse(envelope.actorToken.expiresAt) <= Date.now()))
    )
      throw new ManagedJoinOwnerError(400);
    if (Date.now() < this.openUntil) throw new ManagedJoinOwnerError(503);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ManagedJoinOwnerError(504));
      }, this.options.timeoutMs);
    });
    const url = new URL(path, this.options.baseUrl).href;
    const work = async (): Promise<unknown> => {
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
        throw new ManagedJoinOwnerError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ManagedJoinOwnerError(503);
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
            throw new ManagedJoinOwnerError(503);
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(text) as unknown;
    };
    try {
      const result = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 3) this.openUntil = Date.now() + 30000;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
