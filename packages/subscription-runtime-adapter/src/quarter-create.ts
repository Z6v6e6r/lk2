import {
  QuarterCreateError,
  qcUuid,
  parseQuarterRequest,
  parseQuarterAdmission,
  parseQuarterOutcome,
  qcReadBody,
  qcAdmissionHash,
  type QuarterRequest,
  type QuarterAdmission,
} from '@phub/domain/quarter-create';
export const QUARTER_PREPARE_PATH = '/lk/integrations/v1/game-create-preparations';
export const QUARTER_ADMIT_PATH = '/lk/integrations/v1/game-create-operations/admissions';
export const quarterReadPath = (id: string) =>
  '/lk/integrations/v1/game-create-operations/' + id + '/read';
export class QuarterPreparationRefused extends QuarterCreateError {
  constructor() {
    super('GAME_QUARTER_CREATE_REFUSED', 409);
  }
}
type Envelope = {
  operationId: string;
  actorDelegation: string;
  correlationId: string;
  actorToken: { token: string; expiresAt: string };
};
export class QuarterCreateOwnerClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      baseUrl: string;
      environment: 'development' | 'production';
      timeoutMs: number;
      fetchImplementation?: typeof fetch;
      onMetric?: (metric: {
        operation: 'prepare' | 'admit' | 'read';
        outcome: 'success' | 'refused' | 'failure';
        durationMs: number;
      }) => void;
    },
  ) {
    const u = new URL(options.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 10000 ||
      (options.environment === 'production'
        ? u.href !== 'https://padlhub.su/'
        : u.protocol !== 'https:' &&
          !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    )
      throw new QuarterCreateError();
  }
  async prepare(request: QuarterRequest, e: Envelope) {
    return this.observe('prepare', async () => {
      const q = parseQuarterRequest(request),
        capsule = await this.send(QUARTER_PREPARE_PATH, 'POST', e, q);
      const admission = await parseQuarterAdmission({ ...q, preparation: capsule });
      if (admission.preparation.operationId !== e.operationId) throw new QuarterCreateError();
      if (
        Date.parse(admission.preparation.observedAt) > Date.now() ||
        Date.parse(admission.preparation.expiresAt) <= Date.now()
      )
        throw new QuarterCreateError();
      return admission;
    });
  }
  async admit(q: QuarterAdmission, e: Envelope) {
    return this.observe('admit', async () => {
      const parsed = await parseQuarterAdmission(q);
      return parseQuarterOutcome(await this.send(QUARTER_ADMIT_PATH, 'POST', e, parsed), parsed);
    });
  }
  async read(q: QuarterAdmission, e: Envelope) {
    return this.observe('read', async () => {
      const parsed = await parseQuarterAdmission(q);
      return parseQuarterOutcome(
        await this.send(
          quarterReadPath(e.operationId),
          'POST',
          e,
          qcReadBody(e.operationId, await qcAdmissionHash(parsed)),
        ),
        parsed,
      );
    });
  }
  private async observe<T>(
    operation: 'prepare' | 'admit' | 'read',
    run: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    let outcome: 'success' | 'refused' | 'failure' = 'failure';
    try {
      const value = await run();
      outcome = 'success';
      return value;
    } catch (error) {
      if (error instanceof QuarterPreparationRefused) outcome = 'refused';
      throw error;
    } finally {
      try {
        this.options.onMetric?.({
          operation,
          outcome,
          durationMs: Math.max(0, performance.now() - start),
        });
      } catch {
        /* Telemetry must not change command custody. */
      }
    }
  }
  private async send(
    path: string,
    method: 'POST' | 'GET',
    envelope: Envelope,
    body?: unknown,
  ): Promise<unknown> {
    if (
      !qcUuid(envelope.operationId) ||
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId) ||
      /[\r\n]/.test(envelope.correlationId) ||
      !envelope.actorToken ||
      !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
      !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
      Date.parse(envelope.actorToken.expiresAt) <= Date.now()
    )
      throw new QuarterCreateError('GAME_QUARTER_CREATE_INPUT_INVALID', 400);
    if (Date.now() < this.openUntil) throw new QuarterCreateError();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new QuarterCreateError('GAME_QUARTER_CREATE_UNAVAILABLE', 504));
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
          ...(envelope.actorToken
            ? { 'X-Subscription-Actor-Token': envelope.actorToken.token }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.url && response.url !== url) {
        await response.body?.cancel();
        throw new QuarterCreateError('GAME_QUARTER_CREATE_UNAVAILABLE', 503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new QuarterCreateError();
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
            throw new QuarterCreateError();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(text);
      if (response.status !== 200 && response.status !== 202) {
        if (
          path === QUARTER_PREPARE_PATH &&
          (response.status === 409 || response.status === 403) &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).sort().join() === 'code,error' &&
          (response.status === 403
            ? (value as Record<string, unknown>).code ===
              'GAME_CREATE_PREPARATION_SUBSCRIPTION_MISMATCH'
            : [
                'GAME_CREATE_LOCATION_MISMATCH',
                'GAME_CREATE_SERVICE_MISMATCH',
                'GAME_CREATE_SERVICE_UNRESOLVED',
                'GAME_CREATE_PRICE_UNRESOLVED',
                'GAME_CREATE_PREPARATION_EXPIRED',
              ].includes(
                typeof (value as Record<string, unknown>).code === 'string'
                  ? ((value as Record<string, unknown>).code as string)
                  : '',
              )) &&
          (value as Record<string, unknown>).error === (value as Record<string, unknown>).code
        )
          throw new QuarterPreparationRefused();
        throw new QuarterCreateError();
      }
      if (path === QUARTER_PREPARE_PATH && response.status !== 200) throw new QuarterCreateError();
      return value;
    };
    try {
      const result = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      if (error instanceof QuarterPreparationRefused) throw error;
      this.failures += 1;
      if (this.failures >= 3) this.openUntil = Date.now() + 30000;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
