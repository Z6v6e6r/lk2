import {
  createGameAttemptStorageKey,
  loadCreateGameAttempt,
  type CreateGameAttemptLockManager,
} from './create-game-attempt.js';
import type { AuthGateway } from './auth-gateway.js';
import type { QuarterCreateInput, QuarterCreateResult } from '@phub/api-contracts';
export interface QuarterCustody {
  version: 1;
  tenantId: string;
  userId: string;
  key: string;
  request: QuarterCreateInput;
  operationId?: string;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact = (v: unknown, keys: string): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== keys.split(',').sort().join()
  )
    throw new Error('QUARTER_CUSTODY_INVALID');
  return v as Record<string, unknown>;
};
export const quarterStorageKey = (p: { tenantId: string; userId: string }) =>
  'phub.quarter-create.v1:' + p.tenantId + ':' + p.userId;
export function quarterBrowserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
export function quarterInput(v: unknown): QuarterCreateInput {
  const r = exact(v, 'stationId,courtId,startsAt,subscriptionId');
  if (
    ![r.stationId, r.courtId, r.subscriptionId].every(uuid) ||
    typeof r.startsAt !== 'string' ||
    !Number.isFinite(Date.parse(r.startsAt)) ||
    new Date(r.startsAt).toISOString() !== r.startsAt ||
    Date.parse(r.startsAt) % 60000
  )
    throw new Error('QUARTER_CUSTODY_INVALID');
  return {
    stationId: r.stationId as string,
    courtId: r.courtId as string,
    startsAt: r.startsAt,
    subscriptionId: r.subscriptionId as string,
  };
}
export function loadQuarterCustody(
  storage: Storage,
  p: { tenantId: string; userId: string },
): QuarterCustody | null {
  const raw = storage.getItem(quarterStorageKey(p));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw),
    r = exact(
      parsed,
      Object.hasOwn(parsed as object, 'operationId')
        ? 'version,tenantId,userId,key,request,operationId'
        : 'version,tenantId,userId,key,request',
    );
  if (
    r.version !== 1 ||
    r.tenantId !== p.tenantId ||
    r.userId !== p.userId ||
    typeof r.key !== 'string' ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(r.key) ||
    /[\r\n]/.test(r.key) ||
    (r.operationId !== undefined && !uuid(r.operationId))
  )
    throw new Error('QUARTER_CUSTODY_INVALID');
  return {
    version: 1,
    ...p,
    key: r.key,
    request: quarterInput(r.request),
    ...(r.operationId ? { operationId: r.operationId } : {}),
  };
}
export function saveQuarterCustody(storage: Storage, c: QuarterCustody) {
  storage.setItem(quarterStorageKey(c), JSON.stringify(c));
  if (JSON.stringify(loadQuarterCustody(storage, c)) !== JSON.stringify(c))
    throw new Error('QUARTER_STORAGE_UNAVAILABLE');
}
async function hash(v: string) {
  return (
    'sha256:' +
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}
async function quarterUuidHash(value: string) {
  const h = (await hash(value)).slice(7, 39).split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export async function quarterOperationId(c: Pick<QuarterCustody, 'key' | 'tenantId' | 'userId'>) {
  return quarterUuidHash(
    `booked-operation-admission:v1\0lk2-api\0${c.tenantId}\0${c.userId}\0${await hash(c.key)}`,
  );
}
export async function quarterDraftId(c: Pick<QuarterCustody, 'key' | 'tenantId' | 'userId'>) {
  return quarterUuidHash(
    `game-quarter-create:v1\0draft\0${c.tenantId}\0${c.userId}\0${await hash(c.key)}`,
  );
}
export async function validateQuarterView(
  raw: unknown,
  c: QuarterCustody,
): Promise<QuarterCreateResult> {
  const r = exact(
      raw,
      'contractVersion,request,keySha256,operation,gameProjection,registration,reason',
    ),
    op = exact(r.operation, 'id,draftId,status'),
    g = exact(r.gameProjection, 'status,gameId'),
    reg = exact(r.registration, 'status,asOf');
  const keyHash = await hash(c.key),
    expectedId = await quarterOperationId(c);
  if (
    r.contractVersion !== 1 ||
    r.keySha256 !== keyHash ||
    JSON.stringify(quarterInput(r.request)) !== JSON.stringify(c.request) ||
    op.id !== expectedId ||
    (c.operationId && op.id !== c.operationId) ||
    op.draftId !== (await quarterDraftId(c)) ||
    typeof op.status !== 'string' ||
    ![
      'PENDING',
      'UNKNOWN',
      'CONFIRMED',
      'REJECTED',
      'REFUSED_NOT_DISPATCHED',
      'EXPIRED_NOT_DISPATCHED',
    ].includes(op.status) ||
    typeof g.status !== 'string' ||
    !['AVAILABLE', 'PENDING'].includes(g.status) ||
    (g.status === 'AVAILABLE' ? !uuid(g.gameId) || op.status !== 'CONFIRMED' : g.gameId !== null) ||
    typeof reg.status !== 'string' ||
    !['CONFIRMED', 'UNKNOWN'].includes(reg.status) ||
    (reg.asOf !== null &&
      (typeof reg.asOf !== 'string' ||
        !Number.isFinite(Date.parse(reg.asOf)) ||
        new Date(reg.asOf).toISOString() !== reg.asOf ||
        Date.parse(reg.asOf) > Date.now())) ||
    (reg.status === 'CONFIRMED' && reg.asOf === null) ||
    (['REFUSED_NOT_DISPATCHED', 'EXPIRED_NOT_DISPATCHED', 'REJECTED'].includes(op.status) &&
      (reg.status !== 'UNKNOWN' || reg.asOf !== null)) ||
    (r.reason !== null && (typeof r.reason !== 'string' || !/^[A-Z0-9_]{1,150}$/.test(r.reason)))
  )
    throw new Error('QUARTER_RESULT_INVALID');
  return r as unknown as QuarterCreateResult;
}
export function quarterCanReplace(v: QuarterCreateResult) {
  return ['REFUSED_NOT_DISPATCHED', 'EXPIRED_NOT_DISPATCHED', 'REJECTED'].includes(
    v.operation.status,
  );
}

export class QuarterCreateAttempts {
  private readonly session: string | null;
  constructor(
    private readonly principal: { tenantId: string; userId: string },
    private readonly storage: Storage,
    private readonly locks: CreateGameAttemptLockManager | undefined,
    private readonly gateway: AuthGateway,
    private readonly current: () => boolean,
  ) {
    this.session = gateway.quarterCreatePrincipal?.() ?? null;
  }
  isCurrent() {
    return (
      this.current() &&
      this.session !== null &&
      this.session.startsWith(`${this.principal.tenantId}:${this.principal.userId}:`) &&
      this.gateway.quarterCreatePrincipal?.() === this.session
    );
  }
  load() {
    return loadQuarterCustody(this.storage, this.principal);
  }
  private assert() {
    if (!this.isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
  }
  private async locked<T>(fn: () => Promise<T>) {
    this.assert();
    if (!this.locks) throw new Error('QUARTER_LOCK_UNAVAILABLE');
    return this.locks.request(
      createGameAttemptStorageKey(this.principal) + ':owner',
      { mode: 'exclusive' },
      async () => {
        this.assert();
        return fn();
      },
    );
  }
  async submit(raw: QuarterCreateInput) {
    return this.locked(async () => {
      const q = quarterInput(raw);
      const previous = this.storage.getItem(
        quarterStorageKey(this.principal) + ':previous-confirmed',
      );
      if (previous) {
        const saved = exact(JSON.parse(previous), 'custody,proof'),
          c = saved.custody as QuarterCustody;
        if (!c || c.tenantId !== this.principal.tenantId || c.userId !== this.principal.userId)
          throw new Error('QUARTER_CUSTODY_INVALID');
        const v = await validateQuarterView(saved.proof, c);
        this.assert();
        if (v.operation.status !== 'CONFIRMED' || v.gameProjection.status !== 'AVAILABLE')
          throw new Error('QUARTER_CUSTODY_INVALID');
        if (
          q.stationId === c.request.stationId &&
          q.courtId === c.request.courtId &&
          q.startsAt === c.request.startsAt
        )
          throw new Error('QUARTER_DIFFERENT_TARGET_REQUIRED');
      }
      if (this.load()) throw new Error('QUARTER_ORIGINAL_EXISTS');
      const legacy = loadCreateGameAttempt(this.principal, this.storage);
      if (legacy && legacy.state !== 'RESOLVED') throw new Error('QUARTER_ORIGINAL_EXISTS');
      const capability = await this.gateway.getQuarterCreateCapability?.();
      this.assert();
      if (
        capability?.contractVersion !== 1 ||
        capability.available !== true ||
        !this.gateway.createQuarterGame
      )
        throw new Error('QUARTER_UNAVAILABLE');
      // Nothing is persisted until capability and complete input are validated. Custody precedes HTTP.
      const c: QuarterCustody = {
        version: 1,
        ...this.principal,
        key: crypto.randomUUID(),
        request: q,
      };
      c.operationId = await quarterOperationId(c);
      this.assert();
      saveQuarterCustody(this.storage, c);
      this.assert();
      const rawResult = await this.gateway.createQuarterGame(q, c.key);
      return this.accept(c, rawResult);
    });
  }
  async read() {
    return this.locked(async () => {
      const c = this.load();
      if (!c || !this.gateway.getQuarterCreateOperation)
        throw new Error('QUARTER_ORIGINAL_MISSING');
      const result = await this.gateway.getQuarterCreateOperation(c.key);
      return this.accept(c, result);
    });
  }
  async recover() {
    return this.locked(async () => {
      const c = this.load();
      if (!c || !this.gateway.reconcileQuarterCreateOperation)
        throw new Error('QUARTER_ORIGINAL_MISSING');
      const id = c.operationId ?? (await quarterOperationId(c));
      this.assert();
      return this.accept(
        this.load()!,
        await this.gateway.reconcileQuarterCreateOperation(id, c.request, c.key),
      );
    });
  }
  private async accept(c: QuarterCustody, raw: unknown) {
    this.assert();
    const result = await validateQuarterView(raw, c);
    this.assert();
    const stored = this.load();
    if (
      !stored ||
      stored.key !== c.key ||
      JSON.stringify(stored.request) !== JSON.stringify(c.request)
    )
      throw new Error('QUARTER_CUSTODY_CHANGED');
    saveQuarterCustody(this.storage, { ...stored, operationId: result.operation.id });
    return result;
  }
  async chooseAnother(raw: QuarterCreateResult) {
    return this.locked(async () => {
      const c = this.load();
      if (!c) throw new Error('QUARTER_ORIGINAL_MISSING');
      const v = await validateQuarterView(raw, c);
      this.assert();
      if (
        v.operation.status !== 'CONFIRMED' ||
        v.gameProjection.status !== 'AVAILABLE' ||
        !v.gameProjection.gameId
      )
        throw new Error('QUARTER_TERMINAL_PROOF_REQUIRED');
      const data = JSON.stringify({ custody: c, proof: v });
      for (const key of [
        quarterStorageKey(c) + ':terminal:' + c.key,
        quarterStorageKey(c) + ':previous-confirmed',
      ]) {
        this.storage.setItem(key, data);
        if (this.storage.getItem(key) !== data) throw new Error('QUARTER_STORAGE_UNAVAILABLE');
      }
      this.assert();
      this.storage.removeItem(quarterStorageKey(c));
    });
  }
  async chooseNew(raw: QuarterCreateResult) {
    return this.locked(async () => {
      const c = this.load();
      if (!c) throw new Error('QUARTER_ORIGINAL_MISSING');
      const v = await validateQuarterView(raw, c);
      this.assert();
      if (!quarterCanReplace(v)) throw new Error('QUARTER_TERMINAL_PROOF_REQUIRED');
      const historyKey = quarterStorageKey(c) + ':terminal:' + c.key;
      this.storage.setItem(historyKey, JSON.stringify({ custody: c, proof: v }));
      if (this.storage.getItem(historyKey) !== JSON.stringify({ custody: c, proof: v }))
        throw new Error('QUARTER_STORAGE_UNAVAILABLE');
      this.storage.removeItem(quarterStorageKey(c));
    });
  }
}
