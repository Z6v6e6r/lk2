import { ApiClientError } from '@phub/api-sdk';
import { readNativeJoinBody } from './native-game-join-wire.js';
import type { GameCard, GameCommandResult, HomeDashboard } from '@phub/api-sdk';
import type { GameJoinAttemptLockManager } from './game-join-attempt.js';
import {
  classifyGameJoinErrorCode,
  checkGameJoinConditions,
  classifyGameJoinOperation,
  gameJoinRequiresPaidFlow,
  readGameJoinCommandResult,
  readGameJoinConditions,
  type GameJoinConditionsView,
} from './game-join-flow.js';
export type NativeJoinResource = 'join' | 'conditions' | 'paidStatus' | 'operation' | 'reconcile';
export interface NativeJoinRequest {
  resource: NativeJoinResource;
  resourceId: string;
  key?: string;
  body?: string;
  query?: Record<string, string>;
}
export interface NativeJoinGateway {
  readonly principal: () => string | null;
  readonly getGame: (id: string) => Promise<GameCard>;
  readonly getHomeDashboard: () => Promise<HomeDashboard>;
  readonly request: (request: NativeJoinRequest) => Promise<unknown>;
}
export interface NativeJoinAttempt {
  version: 1;
  gameId: string;
  key: string;
  body: string;
  hash: string;
  paid: boolean;
  dispatchStarted: boolean;
  operationId?: string;
  membershipRevision?: number;
  state: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  revision: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = async (body: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
function readNativeJoinStored(raw: string, id: string): NativeJoinAttempt {
  const v = JSON.parse(raw) as NativeJoinAttempt;
  if (
    !v ||
    v.version !== 1 ||
    v.gameId !== id ||
    !uuid.test(v.key) ||
    typeof v.body !== 'string' ||
    v.body.length > 2048 ||
    !/^[0-9a-f]{64}$/.test(v.hash) ||
    typeof v.paid !== 'boolean' ||
    typeof v.dispatchStarted !== 'boolean' ||
    !['PENDING', 'CONFIRMED', 'REJECTED'].includes(v.state) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    (v.operationId !== undefined && !uuid.test(v.operationId)) ||
    Object.keys(v).some(
      (k) =>
        ![
          'version',
          'gameId',
          'key',
          'body',
          'hash',
          'paid',
          'dispatchStarted',
          'operationId',
          'membershipRevision',
          'state',
          'revision',
        ].includes(k),
    )
  )
    throw new Error('NATIVE_JOIN_CUSTODY_INVALID');
  const input = readNativeJoinBody(v.body);
  if (
    Boolean(input.subscriptionInstanceId) !== v.paid ||
    (v.membershipRevision !== undefined &&
      (!Number.isSafeInteger(v.membershipRevision) || v.membershipRevision < 0))
  )
    throw new Error('NATIVE_JOIN_CUSTODY_INVALID');
  return v;
}
export function nativeJoinStorageKey(scope: { tenantId: string; userId: string }, id: string) {
  return `phub.native-join.v1:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}:${id}`;
}
export function nativeJoinLeaveAdmission(
  storage: Pick<Storage, 'getItem'>,
  scope: { tenantId: string; userId: string },
) {
  return {
    name: (id: string) => nativeJoinStorageKey(scope, id),
    assertAllowed(id: string) {
      const raw = storage.getItem(nativeJoinStorageKey(scope, id));
      if (raw === null) return;
      const v = readNativeJoinStored(raw, id);
      if (!v || v.version !== 1 || v.gameId !== id || !['CONFIRMED', 'REJECTED'].includes(v.state))
        throw new Error('NATIVE_JOIN_PENDING');
    },
  };
}
/** Two real native consumers share one account/game admission lock and durable original intent. */
export class NativeGameJoinAttempts {
  private readonly original: string | null;
  constructor(
    private readonly scope: { tenantId: string; userId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly locks: GameJoinAttemptLockManager,
    private readonly gateway: NativeJoinGateway,
    private readonly isActive: () => boolean = () => true,
    private readonly onCanonicalGame?: (game: GameCard) => void,
  ) {
    this.original = gateway.principal();
  }
  private current() {
    if (!this.original || !this.isActive() || this.gateway.principal() !== this.original)
      throw new Error('NATIVE_JOIN_SCOPE_CHANGED');
  }
  private name(id: string) {
    if (!uuid.test(id) || !this.scope.tenantId || !this.scope.userId)
      throw new Error('NATIVE_JOIN_SCOPE_INVALID');
    return nativeJoinStorageKey(this.scope, id);
  }
  private noPendingLeave(id: string) {
    const key = `phub.self-leave.v1:${encodeURIComponent(this.scope.tenantId)}:${encodeURIComponent(this.scope.userId)}:${id}`;
    if (this.storage.getItem(key) !== null) throw new Error('NATIVE_JOIN_PENDING_LEAVE');
  }
  load(id: string): NativeJoinAttempt | null {
    const raw = this.storage.getItem(this.name(id));
    if (raw === null) return null;
    return readNativeJoinStored(raw, id);
  }
  async conditions(id: string, subscriptionId: string): Promise<GameJoinConditionsView> {
    this.current();
    this.noPendingLeave(id);
    if (this.load(id)?.state === 'PENDING') throw new Error('NATIVE_JOIN_PENDING');
    const game = await this.gateway.getGame(id);
    this.current();
    if (
      game.id !== id ||
      !game.allowedActions.includes('JOIN') ||
      !gameJoinRequiresPaidFlow(game) ||
      !uuid.test(subscriptionId)
    )
      throw new Error('NATIVE_JOIN_UNAVAILABLE');
    const raw = await this.gateway.request({
      resource: 'conditions',
      resourceId: id,
      query: { expectedRevision: String(game.revision), subscriptionInstanceId: subscriptionId },
    });
    this.current();
    const conditions = readGameJoinConditions(raw);
    if (
      !conditions ||
      checkGameJoinConditions({
        conditions,
        gameId: id,
        revision: game.revision,
        subscriptionInstanceId: subscriptionId,
        nowMs: Date.now(),
      }).kind !== 'CONSENT'
    )
      throw new Error('NATIVE_JOIN_CONDITIONS_UNAVAILABLE');
    return conditions;
  }
  async submit(id: string, conditions?: GameJoinConditionsView): Promise<NativeJoinAttempt> {
    this.current();
    const attempt = await this.locks.request(this.name(id), { mode: 'exclusive' }, async () => {
      this.current();
      this.noPendingLeave(id);
      const old = this.load(id);
      if (old?.state === 'PENDING') throw new Error('NATIVE_JOIN_PENDING');
      const game = await this.gateway.getGame(id);
      this.current();
      if (
        game.id !== id ||
        !game.allowedActions.includes('JOIN') ||
        !Number.isSafeInteger(game.revision)
      )
        throw new Error('NATIVE_JOIN_UNAVAILABLE');
      // A lagging projection cannot reopen a completed intent; a later roster transition must advance revision.
      if (
        old?.state === 'CONFIRMED' &&
        (old.membershipRevision === undefined ||
          game.revision <= Math.max(old.revision, old.membershipRevision))
      )
        throw new Error('NATIVE_JOIN_PROJECTION_PENDING');
      const paid = gameJoinRequiresPaidFlow(game);
      let body: string;
      if (paid) {
        if (!conditions) throw new Error('NATIVE_JOIN_CONSENT_REQUIRED');
        const check = checkGameJoinConditions({
          conditions,
          gameId: id,
          revision: game.revision,
          subscriptionInstanceId: conditions.subscriptionInstanceId,
          nowMs: Date.now(),
        });
        if (check.kind !== 'CONSENT' || !check.consent)
          throw new Error('NATIVE_JOIN_CONSENT_EXPIRED');
        body = JSON.stringify({
          expectedRevision: game.revision,
          subscriptionInstanceId: conditions.subscriptionInstanceId,
          priceConsent: check.consent,
        });
      } else {
        if (conditions) throw new Error('NATIVE_JOIN_MODE_CHANGED');
        body = JSON.stringify({ expectedRevision: game.revision });
      }
      const hash = await sha(body);
      this.current();
      this.noPendingLeave(id);
      const value: NativeJoinAttempt = {
        version: 1,
        gameId: id,
        key: crypto.randomUUID(),
        body,
        hash,
        paid,
        dispatchStarted: true,
        state: 'PENDING',
        revision: game.revision,
      };
      this.storage.setItem(this.name(id), JSON.stringify(value));
      return value;
    });
    this.current();
    return this.dispatch(attempt, {
      resource: 'join',
      resourceId: id,
      key: attempt.key,
      body: attempt.body,
    });
  }
  async recover(id: string, retry = false): Promise<NativeJoinAttempt> {
    this.current();
    const a = this.load(id);
    if (!a) throw new Error('NATIVE_JOIN_NO_ATTEMPT');
    if (a.state === 'CONFIRMED') {
      const game = await this.gateway.getGame(id);
      this.current();
      if (
        game.id === id &&
        game.viewerRelation === 'PARTICIPANT' &&
        Number.isSafeInteger(game.revision)
      ) {
        return this.locks.request(this.name(id), { mode: 'exclusive' }, () => {
          this.current();
          const current = this.load(id);
          if (!current || current.key !== a.key) throw new Error('NATIVE_JOIN_CUSTODY_CHANGED');
          if (game.revision < current.revision) return current;
          const next = {
            ...current,
            membershipRevision: Math.max(current.membershipRevision ?? 0, game.revision),
          };
          this.storage.setItem(this.name(id), JSON.stringify(next));
          this.onCanonicalGame?.(game);
          return next;
        });
      }
      return a;
    }
    if (a.state !== 'PENDING') return a;
    if ((await sha(a.body)) !== a.hash) throw new Error('NATIVE_JOIN_CUSTODY_INVALID');
    this.current();
    if (a.paid) {
      const request: NativeJoinRequest =
        retry && a.operationId
          ? {
              resource: 'reconcile',
              resourceId: a.operationId,
              key: `join-reconcile:${a.operationId}`,
            }
          : { resource: 'paidStatus', resourceId: id, key: a.key };
      return this.dispatch(a, request);
    }
    if (a.operationId)
      return this.dispatch(a, { resource: 'operation', resourceId: a.operationId, key: a.key });
    if (!retry) return a; // No free read-by-key endpoint; only an explicit original POST can recover a lost ACK.
    return this.dispatch(a, { resource: 'join', resourceId: id, key: a.key, body: a.body });
  }
  private async dispatch(
    a: NativeJoinAttempt,
    request: NativeJoinRequest,
  ): Promise<NativeJoinAttempt> {
    this.current();
    if ((await sha(a.body)) !== a.hash) throw new Error('NATIVE_JOIN_CUSTODY_INVALID');
    this.current();
    let raw: unknown;
    try {
      raw = await this.gateway.request(request);
    } catch (error) {
      this.current();
      // Only established pre-dispatch business refusals release the attempt; unknown/404/5xx retain it.
      if (
        request.resource === 'join' &&
        error instanceof ApiClientError &&
        error.status >= 400 &&
        error.status < 500 &&
        [
          'GAME_PRICE_CONFIRMATION_REQUIRED',
          'GAME_SUBSCRIPTION_SELECTION_REQUIRED',
          'GAME_SERVICE_BLOCKED',
          'GAME_PAYMENT_REQUIRED',
          'GAME_REVISION_CONFLICT',
          'GAME_FULL',
          'GAME_ALREADY_JOINED',
        ].includes(error.code) &&
        classifyGameJoinErrorCode(error.code, { paid: a.paid }).custody === 'DISCARD'
      ) {
        return this.locks.request(this.name(a.gameId), { mode: 'exclusive' }, () => {
          this.current();
          const current = this.load(a.gameId);
          if (!current || current.key !== a.key) throw new Error('NATIVE_JOIN_CUSTODY_CHANGED');
          if (current.state === 'CONFIRMED') return current;
          const rejected: NativeJoinAttempt = { ...current, state: 'REJECTED' };
          this.storage.setItem(this.name(a.gameId), JSON.stringify(rejected));
          return rejected;
        });
      }
      throw error;
    }
    this.current();
    const parsed = readGameJoinCommandResult(raw),
      r = raw as GameCommandResult;
    if (
      !parsed ||
      r.operation?.type !== 'JOIN_GAME' ||
      r.commandId !== parsed.operation.id ||
      !uuid.test(parsed.operation.id) ||
      parsed.operation.gameId !== a.gameId ||
      (a.operationId !== undefined && a.operationId !== parsed.operation.id)
    )
      throw new Error('NATIVE_JOIN_RESPONSE_INVALID');
    const classification = classifyGameJoinOperation(parsed, { paid: a.paid });
    return this.locks.request(this.name(a.gameId), { mode: 'exclusive' }, () => {
      this.current();
      const current = this.load(a.gameId);
      if (!current || current.key !== a.key || current.hash !== a.hash)
        throw new Error('NATIVE_JOIN_CUSTODY_CHANGED');
      if (current.operationId !== undefined && current.operationId !== parsed.operation.id)
        throw new Error('NATIVE_JOIN_RESPONSE_INVALID');
      if (
        current.state === 'CONFIRMED' ||
        (current.state === 'REJECTED' && !classification.trustedSuccess)
      )
        return current;
      const next: NativeJoinAttempt = {
        ...current,
        operationId: parsed.operation.id,
        state: classification.trustedSuccess
          ? 'CONFIRMED'
          : classification.custody === 'DISCARD'
            ? 'REJECTED'
            : 'PENDING',
        revision: classification.trustedSuccess
          ? Math.max(current.revision, parsed.operation.aggregateRevision ?? current.revision)
          : current.revision,
      };
      this.storage.setItem(this.name(a.gameId), JSON.stringify(next));
      return next;
    });
  }
}
