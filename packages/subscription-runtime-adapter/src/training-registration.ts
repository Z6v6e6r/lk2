import {
  TrainingRegistrationError,
  parseTrainingCapsule,
  parseTrainingAdmission,
  parseTrainingRequest,
  parseTrainingReceipt,
  trainingUuid,
  type TrainingRequest,
  type TrainingAdmission,
  type TrainingAuthority,
  type TrainingReceipt,
} from '@phub/domain/training-registration';
export class TrainingPreparationRefused extends TrainingRegistrationError {
  constructor() {
    super('TRAINING_REGISTRATION_UNSUPPORTED', 409);
  }
}
export const TRAINING_PREPARE_PATH = '/lk/integrations/v1/training-registration-preparations';
export const TRAINING_ADMIT_PATH = '/lk/integrations/v1/training-registration-admissions';
export const TRAINING_READ_PREFIX = '/lk/integrations/v1/training-registrations/';
export type TrainingOwnerOutcome = {
  status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED';
  asOf: string;
  receipt?: TrainingReceipt;
};
const uuid = trainingUuid;
type Envelope = {
  operationId: string;
  actorDelegation: string;
  correlationId: string;
  actorToken: { token: string; expiresAt: string };
};
export class TrainingRegistrationOwnerClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      baseUrl: string;
      environment: 'development' | 'production';
      timeoutMs: number;
      fetchImplementation?: typeof fetch;
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
      throw new TrainingRegistrationError();
  }
  async prepare(request: TrainingRequest, envelope: Envelope) {
    const raw = await this.send(
      TRAINING_PREPARE_PATH,
      'POST',
      envelope,
      parseTrainingRequest(request),
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TrainingRegistrationError();
    const r = raw as Record<string, unknown>;
    if (
      Object.keys(r).sort().join() !==
        'action,contractVersion,nonBinding,operationId,preparation' ||
      r.contractVersion !== 1 ||
      r.nonBinding !== true ||
      r.operationId !== envelope.operationId ||
      r.action !== 'BOOK_GROUP_TRAINING'
    )
      throw new TrainingRegistrationError();
    return parseTrainingCapsule(r.preparation);
  }
  async admit(request: TrainingAdmission, authority: TrainingAuthority, envelope: Envelope) {
    return this.outcome(
      await this.send(TRAINING_ADMIT_PATH, 'POST', envelope, await parseTrainingAdmission(request)),
      authority,
      envelope.operationId,
    );
  }
  async read(authority: TrainingAuthority, envelope: Envelope) {
    return this.outcome(
      await this.send(TRAINING_READ_PREFIX + envelope.operationId, 'GET', envelope),
      authority,
      envelope.operationId,
    );
  }
  private async outcome(
    raw: unknown,
    authority: TrainingAuthority,
    id: string,
  ): Promise<TrainingOwnerOutcome> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TrainingRegistrationError();
    const r = raw as Record<string, unknown>,
      confirmed = r.status === 'CONFIRMED';
    if (
      Object.keys(r).sort().join() !==
        (confirmed
          ? 'asOf,contractVersion,operationId,reason,receipt,status'
          : 'asOf,contractVersion,operationId,reason,status') ||
      r.contractVersion !== 1 ||
      r.operationId !== id ||
      !['CONFIRMED', 'PENDING', 'UNKNOWN'].includes(String(r.status)) ||
      typeof r.asOf !== 'string' ||
      !Number.isFinite(Date.parse(r.asOf)) ||
      new Date(r.asOf).toISOString() !== r.asOf ||
      Date.parse(r.asOf) > Date.now() ||
      (confirmed
        ? r.reason !== 'OWNER_CONFIRMED'
        : r.status === 'PENDING'
          ? r.reason !== 'OWNER_PENDING'
          : !['OWNER_OUTCOME_UNKNOWN', 'TARGET_UNAVAILABLE'].includes(String(r.reason)))
    )
      throw new TrainingRegistrationError();
    if (!confirmed) return { status: r.status as 'PENDING' | 'UNKNOWN', asOf: r.asOf };
    const receipt = await parseTrainingReceipt(r.receipt, authority);
    if (
      Date.parse(receipt.confirmedAt) > Date.parse(r.asOf) ||
      Date.parse(receipt.confirmedAt) > Date.now()
    )
      throw new TrainingRegistrationError();
    return { status: 'CONFIRMED', asOf: r.asOf, receipt };
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
      !envelope.actorToken ||
      !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
      !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
      Date.parse(envelope.actorToken.expiresAt) <= Date.now()
    )
      throw new TrainingRegistrationError('TRAINING_REGISTRATION_INPUT_INVALID', 400);
    if (Date.now() < this.openUntil) throw new TrainingRegistrationError();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new TrainingRegistrationError('TRAINING_REGISTRATION_UNAVAILABLE', 504));
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
        throw new TrainingRegistrationError('TRAINING_REGISTRATION_UNAVAILABLE', 503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TrainingRegistrationError();
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
            throw new TrainingRegistrationError();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(text);
      if (response.status !== 200) {
        if (
          path === TRAINING_PREPARE_PATH &&
          response.status === 409 &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).sort().join() === 'code,error' &&
          (value as Record<string, unknown>).code === 'TRAINING_REGISTRATION_UNSUPPORTED' &&
          (value as Record<string, unknown>).error === 'TRAINING_REGISTRATION_UNSUPPORTED'
        )
          throw new TrainingPreparationRefused();
        throw new TrainingRegistrationError();
      }
      return value;
    };
    try {
      const result = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      if (error instanceof TrainingPreparationRefused) throw error;
      this.failures += 1;
      if (this.failures >= 3) this.openUntil = Date.now() + 30000;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
