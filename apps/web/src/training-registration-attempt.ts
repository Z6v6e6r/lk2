import type { TrainingRegistrationResult } from '@phub/api-contracts';
import type { AuthGateway } from './auth-gateway.js';
import type { GameJoinAttemptLockManager } from './game-join-attempt.js';
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export interface TrainingBrowserAttempt {
  version: 1;
  trainingId: string;
  subscriptionId: string;
  dateHint: string;
  idempotencyKey: string;
  operationId?: string;
}
/** Public request/key custody only; never store owner capsules, receipts or credentials. */
export class TrainingRegistrationAttempts {
  constructor(
    private readonly scope: { tenantId: string; userId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly locks: GameJoinAttemptLockManager,
    private readonly gateway: Pick<AuthGateway, 'registerTraining' | 'getTrainingRegistration'>,
    private readonly isCurrent: () => boolean,
  ) {}
  private current() {
    if (!this.isCurrent()) throw new Error('TRAINING_ACCOUNT_CHANGED');
  }
  private key(id: string) {
    if (!uuid(id) || !uuid(this.scope.tenantId) || !uuid(this.scope.userId))
      throw new Error('TRAINING_CUSTODY_INVALID');
    return `phub.training.v1:${this.scope.tenantId}:${this.scope.userId}:${id}`;
  }
  load(id: string): TrainingBrowserAttempt | null {
    this.current();
    const raw = this.storage.getItem(this.key(id));
    if (raw === null) return null;
    const a = JSON.parse(raw) as TrainingBrowserAttempt;
    if (
      !a ||
      a.version !== 1 ||
      a.trainingId !== id ||
      !uuid(a.subscriptionId) ||
      !uuid(a.idempotencyKey) ||
      (a.operationId !== undefined && !uuid(a.operationId)) ||
      typeof a.dateHint !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(a.dateHint) ||
      Object.keys(a).some(
        (k) =>
          ![
            'version',
            'trainingId',
            'subscriptionId',
            'dateHint',
            'idempotencyKey',
            'operationId',
          ].includes(k),
      )
    )
      throw new Error('TRAINING_CUSTODY_INVALID');
    return a;
  }
  private async accept(a: TrainingBrowserAttempt, r: TrainingRegistrationResult) {
    this.current();
    if (
      !r ||
      Object.keys(r).sort().join() !==
        'dateHint,operation,registration,retryAfterSeconds,subscriptionId,trainingId' ||
      r.trainingId !== a.trainingId ||
      r.subscriptionId !== a.subscriptionId ||
      r.dateHint !== a.dateHint ||
      !r.operation ||
      Object.keys(r.operation).sort().join() !== 'id,status' ||
      !uuid(r.operation.id) ||
      (a.operationId !== undefined && a.operationId !== r.operation.id) ||
      ![
        'PENDING',
        'UNKNOWN',
        'CONFIRMED',
        'EXPIRED_NOT_DISPATCHED',
        'REJECTED_NOT_DISPATCHED',
      ].includes(r.operation.status) ||
      !r.registration ||
      Object.keys(r.registration).sort().join() !== 'asOf,status' ||
      !['UNKNOWN', 'CONFIRMED'].includes(r.registration.status) ||
      (r.registration.asOf !== null &&
        (!Number.isFinite(Date.parse(r.registration.asOf)) ||
          new Date(r.registration.asOf).toISOString() !== r.registration.asOf)) ||
      (r.registration.status === 'CONFIRMED' && r.registration.asOf === null) ||
      (['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(r.operation.status) &&
        (r.registration.status !== 'UNKNOWN' ||
          r.registration.asOf !== null ||
          r.retryAfterSeconds !== null))
    )
      throw new Error('TRAINING_RESPONSE_INVALID');
    await this.locks.request(this.key(a.trainingId), { mode: 'exclusive' }, () => {
      this.current();
      const current = this.load(a.trainingId);
      if (!current || current.idempotencyKey !== a.idempotencyKey)
        throw new Error('TRAINING_CUSTODY_CHANGED');
      if (['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(r.operation.status))
        this.storage.removeItem(this.key(a.trainingId));
      else
        this.storage.setItem(
          this.key(a.trainingId),
          JSON.stringify({ ...current, operationId: r.operation.id }),
        );
    });
    return r;
  }
  async submit(trainingId: string, input: { dateHint: string; subscriptionId: string }) {
    this.current();
    if (!this.gateway.registerTraining) throw new Error('TRAINING_UNAVAILABLE');
    const a = await this.locks.request(this.key(trainingId), { mode: 'exclusive' }, () => {
      this.current();
      const old = this.load(trainingId);
      if (old) {
        if (old.subscriptionId !== input.subscriptionId || old.dateHint !== input.dateHint)
          throw new Error('TRAINING_ORIGINAL_ATTEMPT_REQUIRED');
        return old;
      }
      if (!uuid(input.subscriptionId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dateHint))
        throw new Error('TRAINING_INPUT_INVALID');
      const fresh: TrainingBrowserAttempt = {
        version: 1,
        trainingId,
        ...input,
        idempotencyKey: crypto.randomUUID(),
      };
      this.storage.setItem(this.key(trainingId), JSON.stringify(fresh));
      return fresh;
    });
    this.current();
    const r = await this.gateway.registerTraining(
      trainingId,
      { dateHint: a.dateHint, subscriptionId: a.subscriptionId },
      a.idempotencyKey,
    );
    return this.accept(a, r);
  }
  async read(trainingId: string) {
    this.current();
    const a = this.load(trainingId);
    if (!a) return null;
    if (!this.gateway.getTrainingRegistration) throw new Error('TRAINING_UNAVAILABLE');
    this.current();
    return this.accept(a, await this.gateway.getTrainingRegistration(trainingId, a.idempotencyKey));
  }
}
