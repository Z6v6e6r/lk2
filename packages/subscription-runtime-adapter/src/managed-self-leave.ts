import {
  parseManagedSelfLeaveRequest,
  parseManagedSelfLeaveReceipt,
  type ManagedSelfLeaveRequest,
  type ManagedSelfLeaveReceipt,
} from '@phub/domain';
export {
  parseManagedSelfLeaveRequest,
  parseManagedSelfLeaveReceipt,
  managedSelfLeaveRequestSha256,
  managedSelfLeaveReceiptSha256,
  managedSelfLeaveJoinReceiptSha256,
  managedSelfLeaveOperationId,
  type ManagedSelfLeaveRequest,
  type ManagedSelfLeaveReceipt,
} from '@phub/domain';
export const MANAGED_SELF_LEAVE_ADMISSION_PATH =
  '/lk/integrations/v1/managed-self-leave-admissions';
export const MANAGED_SELF_LEAVE_READ_PREFIX = '/lk/integrations/v1/managed-self-leaves/';
export const MANAGED_SELF_LEAVE_ADMISSION_SCOPE = 'subscription-runtime.managed-self-leave.admit';
export const MANAGED_SELF_LEAVE_READ_SCOPE = 'subscription-runtime.managed-self-leave.read';
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export class ManagedSelfLeaveOwnerError extends Error {
  constructor(public readonly status: number) {
    super('MANAGED_SELF_LEAVE_OWNER_UNAVAILABLE');
  }
}
export interface ManagedSelfLeaveReadOutcome {
  readonly contractVersion: 1;
  readonly operationId: string;
  readonly status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED';
  readonly asOf: string | null;
  readonly reason: 'OWNER_PENDING' | 'RECONCILIATION_REQUIRED' | 'OWNER_LEAVE_CONFIRMED';
  readonly receipt?: ManagedSelfLeaveReceipt;
}
export function parseManagedSelfLeaveReadOutcome(
  value: unknown,
  operationId: string,
): ManagedSelfLeaveReadOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid(operationId))
    throw new ManagedSelfLeaveOwnerError(503);
  const r = value as Record<string, unknown>;
  const confirmed = r.status === 'CONFIRMED';
  if (
    Object.keys(r).sort().join() !==
      ('contractVersion,operationId,status,asOf,reason' + (confirmed ? ',receipt' : ''))
        .split(',')
        .sort()
        .join() ||
    r.contractVersion !== 1 ||
    r.operationId !== operationId ||
    !['PENDING', 'UNKNOWN', 'CONFIRMED'].includes(String(r.status)) ||
    r.reason !==
      (
        {
          PENDING: 'OWNER_PENDING',
          UNKNOWN: 'RECONCILIATION_REQUIRED',
          CONFIRMED: 'OWNER_LEAVE_CONFIRMED',
        } as Record<string, string>
      )[String(r.status)]
  )
    throw new ManagedSelfLeaveOwnerError(503);
  if (!confirmed) {
    if (r.asOf !== null) throw new ManagedSelfLeaveOwnerError(503);
    return structuredClone(r) as unknown as ManagedSelfLeaveReadOutcome;
  }
  const receipt = parseManagedSelfLeaveReceipt(r.receipt);
  if (
    receipt.operationId !== operationId ||
    r.asOf !== receipt.completedAt ||
    Date.parse(receipt.completedAt) > Date.now()
  )
    throw new ManagedSelfLeaveOwnerError(503);
  return { ...r, receipt } as unknown as ManagedSelfLeaveReadOutcome;
}
type Envelope = {
  readonly actorDelegation: string;
  readonly correlationId: string;
  readonly operationId: string;
  readonly actorToken?: { readonly token: string; readonly expiresAt: string };
};
/** Two fixed owner routes, bounded response and no write retries. */
export class ManagedSelfLeaveOwnerClient {
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
      throw new ManagedSelfLeaveOwnerError(503);
  }
  async admit(
    request: ManagedSelfLeaveRequest,
    envelope: Envelope,
  ): Promise<ManagedSelfLeaveReadOutcome> {
    return parseManagedSelfLeaveReadOutcome(
      await this.send(
        MANAGED_SELF_LEAVE_ADMISSION_PATH,
        'POST',
        envelope,
        parseManagedSelfLeaveRequest(request),
      ),
      envelope.operationId,
    );
  }
  async read(envelope: Envelope): Promise<ManagedSelfLeaveReadOutcome> {
    return parseManagedSelfLeaveReadOutcome(
      await this.send(MANAGED_SELF_LEAVE_READ_PREFIX + envelope.operationId, 'GET', envelope),
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
      /[\r\n]/.test(envelope.correlationId) ||
      (method === 'POST' &&
        (!envelope.actorToken ||
          !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
          !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
          Date.parse(envelope.actorToken.expiresAt) <= Date.now()))
    )
      throw new ManagedSelfLeaveOwnerError(400);
    if (Date.now() < this.openUntil) throw new ManagedSelfLeaveOwnerError(503);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ManagedSelfLeaveOwnerError(504));
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
      if (response.status !== 200 || (response.url && response.url !== url)) {
        await response.body?.cancel();
        throw new ManagedSelfLeaveOwnerError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ManagedSelfLeaveOwnerError(503);
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
            throw new ManagedSelfLeaveOwnerError(503);
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
