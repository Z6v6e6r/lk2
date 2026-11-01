import type { GameCommandResult, AuthGateway } from './auth-gateway.js';
import type { GameJoinAttemptLockManager } from './game-join-attempt.js';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
export interface SelfLeaveAttempt {
  version: 1;
  gameId: string;
  idempotencyKey: string;
  operationId?: string;
}
/** Only public IDs and the original command key. No receipt, provider identity or credentials. */
export class GameSelfLeaveAttempts {
  constructor(
    private readonly scope: { tenantId: string; userId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly locks: GameJoinAttemptLockManager,
    private readonly gateway: Pick<
      AuthGateway,
      'leaveGame' | 'getManagedLeaveOperation' | 'reconcileManagedLeaveOperation'
    >,
    private readonly isCurrent: () => boolean = () => true,
  ) {}
  private assertCurrent(): void {
    if (!this.isCurrent()) throw new Error('SELF_LEAVE_SCOPE_CHANGED');
  }
  private key(gameId: string) {
    if (!uuid(gameId) || !this.scope.tenantId || !this.scope.userId)
      throw new Error('SELF_LEAVE_SCOPE_INVALID');
    return `phub.self-leave.v1:${encodeURIComponent(this.scope.tenantId)}:${encodeURIComponent(this.scope.userId)}:${gameId}`;
  }
  load(gameId: string): SelfLeaveAttempt | null {
    const raw = this.storage.getItem(this.key(gameId));
    if (raw === null) return null;
    const value = JSON.parse(raw) as SelfLeaveAttempt;
    if (
      !value ||
      value.version !== 1 ||
      value.gameId !== gameId ||
      !uuid(value.idempotencyKey) ||
      (value.operationId !== undefined && !uuid(value.operationId)) ||
      Object.keys(value).some(
        (k) => !['version', 'gameId', 'idempotencyKey', 'operationId'].includes(k),
      )
    )
      throw new Error('SELF_LEAVE_CUSTODY_INVALID');
    return value;
  }
  private async accept(attempt: SelfLeaveAttempt, result: GameCommandResult): Promise<void> {
    this.assertCurrent();
    if (
      !['ACCEPTED', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(
        result.operation.status,
      ) ||
      result.operation.type !== 'LEAVE_GAME' ||
      result.operation.gameId !== attempt.gameId ||
      !uuid(result.operation.id) ||
      result.commandId !== result.operation.id ||
      (attempt.operationId !== undefined && attempt.operationId !== result.operation.id)
    )
      throw new Error('SELF_LEAVE_RESPONSE_INVALID');
    const proof = result.operation.noDispatch;
    let notDispatched = false;
    if (proof !== undefined) {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(attempt.idempotencyKey),
      );
      const expected =
        'sha256:' +
        Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      if (
        !proof ||
        Object.keys(proof).sort().join(',') !== 'idempotencyKeySha256,outcome,schemaVersion' ||
        proof.schemaVersion !== 1 ||
        proof.outcome !== 'NOT_DISPATCHED' ||
        proof.idempotencyKeySha256 !== expected ||
        result.operation.status !== 'FAILED' ||
        result.operation.error?.code !== 'GAME_NOT_LEAVABLE' ||
        result.operation.nextAction.type !== 'NONE'
      )
        throw new Error('SELF_LEAVE_RESPONSE_INVALID');
      notDispatched = true;
    }
    await this.locks.request(this.key(attempt.gameId), { mode: 'exclusive' }, () => {
      this.assertCurrent();
      const current = this.load(attempt.gameId);
      if (!current || current.idempotencyKey !== attempt.idempotencyKey)
        throw new Error('SELF_LEAVE_CUSTODY_CHANGED');
      if (result.operation.status === 'SUCCEEDED' || notDispatched)
        this.storage.removeItem(this.key(attempt.gameId));
      else
        this.storage.setItem(
          this.key(attempt.gameId),
          JSON.stringify({ ...current, operationId: result.operation.id }),
        );
    });
  }
  async submit(gameId: string): Promise<GameCommandResult> {
    this.assertCurrent();
    const { attempt, fresh } = await this.locks.request(
      this.key(gameId),
      { mode: 'exclusive' },
      () => {
        this.assertCurrent();
        const current = this.load(gameId);
        if (current) return { attempt: current, fresh: false };
        const fresh: SelfLeaveAttempt = { version: 1, gameId, idempotencyKey: crypto.randomUUID() };
        this.storage.setItem(this.key(gameId), JSON.stringify(fresh));
        return { attempt: fresh, fresh: true };
      },
    );
    this.assertCurrent();
    if (!fresh && !this.gateway.reconcileManagedLeaveOperation)
      throw new Error('SELF_LEAVE_RECONCILIATION_UNAVAILABLE');
    const result = fresh
      ? await this.gateway.leaveGame(gameId, { idempotencyKey: attempt.idempotencyKey })
      : await this.gateway.reconcileManagedLeaveOperation!(gameId, attempt.idempotencyKey);
    await this.accept(attempt, result);
    return result;
  }
  async read(gameId: string): Promise<GameCommandResult | null> {
    this.assertCurrent();
    const attempt = this.load(gameId);
    if (!attempt) return null;
    if (!this.gateway.getManagedLeaveOperation) throw new Error('SELF_LEAVE_READ_UNAVAILABLE');
    const result = await this.gateway.getManagedLeaveOperation(gameId, attempt.idempotencyKey);
    await this.accept(attempt, result);
    return result;
  }
}
