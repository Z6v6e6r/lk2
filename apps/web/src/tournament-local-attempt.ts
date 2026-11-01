import type {
  TournamentLocalInput,
  TournamentLocalResult,
  TournamentLocalStatus,
} from '@phub/api-contracts';
import { tournamentUuid, parseTournamentLocalInput, tournamentObject } from '@phub/domain';
import type { AuthGateway } from './auth-gateway.js';
import type { GameJoinAttemptLockManager } from './game-join-attempt.js';
interface Custody {
  version: 1;
  tournamentId: string;
  key: string;
  input: TournamentLocalInput;
  operationId?: string;
}
export class TournamentLocalAttempts {
  constructor(
    private readonly principal: { tenantId: string; userId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly locks: GameJoinAttemptLockManager,
    private readonly gateway: Pick<
      AuthGateway,
      'commandTournament' | 'retryTournament' | 'getTournamentRegistration'
    >,
    private readonly isCurrent: () => boolean,
  ) {}
  private current() {
    if (!this.isCurrent()) throw new Error('TOURNAMENT_ACCOUNT_CHANGED');
  }
  private name(id: string) {
    if (![id, this.principal.tenantId, this.principal.userId].every(tournamentUuid))
      throw new Error('TOURNAMENT_CUSTODY_INVALID');
    return `phub.tournament.v1:${this.principal.tenantId}:${this.principal.userId}:${id}`;
  }
  load(id: string): Custody | null {
    this.current();
    const raw = this.storage.getItem(this.name(id));
    if (raw === null) return null;
    const x = JSON.parse(raw) as Custody;
    if (
      !tournamentObject(
        x,
        x.operationId === undefined
          ? 'version,tournamentId,key,input'
          : 'version,tournamentId,key,input,operationId',
      ) ||
      x.version !== 1 ||
      x.tournamentId !== id ||
      !tournamentUuid(x.key) ||
      (x.operationId !== undefined && !tournamentUuid(x.operationId))
    )
      throw new Error('TOURNAMENT_CUSTODY_INVALID');
    return { ...x, input: parseTournamentLocalInput(x.input) };
  }
  private result(id: string, r: TournamentLocalResult, expected?: Custody) {
    if (
      !tournamentObject(r, 'tournamentId,operation,registration,retryAfterSeconds') ||
      r.tournamentId !== id ||
      !tournamentObject(r.operation, 'id,action,status,reason,generation') ||
      !tournamentUuid(r.operation.id) ||
      !['JOIN', 'LEAVE'].includes(r.operation.action) ||
      !['UNKNOWN', 'REGISTERED', 'LEFT', 'REJECTED'].includes(r.operation.status) ||
      !tournamentObject(r.registration, 'status,asOf') ||
      !['UNKNOWN', 'REGISTERED', 'NOT_REGISTERED_BY_OPERATION'].includes(r.registration.status) ||
      (expected &&
        (r.operation.action !== expected.input.action ||
          (expected.operationId && r.operation.id !== expected.operationId)))
    )
      throw new Error('TOURNAMENT_RESPONSE_INVALID');
    if (
      (r.retryAfterSeconds !== null &&
        (!Number.isInteger(r.retryAfterSeconds) ||
          r.retryAfterSeconds < 1 ||
          r.retryAfterSeconds > 3600)) ||
      (r.registration.asOf !== null &&
        (typeof r.registration.asOf !== 'string' ||
          !Number.isFinite(Date.parse(r.registration.asOf)))) ||
      (r.operation.status === 'UNKNOWN' &&
        (r.operation.reason !== null || r.operation.generation !== null)) ||
      (r.operation.status === 'REJECTED' &&
        (!['FULL', 'MEMBERSHIP_EXISTS', 'GENERATION_NOT_CURRENT'].includes(
          r.operation.reason ?? '',
        ) ||
          r.operation.generation !== null)) ||
      (['REGISTERED', 'LEFT'].includes(r.operation.status) &&
        r.operation.reason !== r.operation.status)
    )
      throw new Error('TOURNAMENT_RESPONSE_INVALID');
    if (
      (r.operation.status === 'REGISTERED' &&
        (r.operation.action !== 'JOIN' || r.operation.generation !== r.operation.id)) ||
      (r.operation.status === 'LEFT' &&
        (r.operation.action !== 'LEAVE' || !tournamentUuid(r.operation.generation))) ||
      (expected?.input.action === 'LEAVE' &&
        r.operation.status === 'LEFT' &&
        r.operation.generation !== expected.input.originalJoinOperationId)
    )
      throw new Error('TOURNAMENT_RESPONSE_INVALID');
    return r;
  }
  private save(id: string, c: Custody, r: TournamentLocalResult) {
    this.current();
    if (r.operation.status === 'UNKNOWN')
      this.storage.setItem(this.name(id), JSON.stringify({ ...c, operationId: r.operation.id }));
    else this.storage.removeItem(this.name(id));
  }
  async read(id: string): Promise<TournamentLocalStatus> {
    this.current();
    return this.locks.request(this.name(id), { mode: 'exclusive' }, async () => {
      this.current();
      if (!this.gateway.getTournamentRegistration) throw new Error('TOURNAMENT_UNAVAILABLE');
      const c = this.load(id);
      this.current();
      const r = await this.gateway.getTournamentRegistration(
        id,
        c
          ? { idempotencyKey: c.key, ...(c.operationId ? { operationId: c.operationId } : {}) }
          : {},
      );
      this.current();
      if (!tournamentObject(r, 'commandsEnabled,result') || typeof r.commandsEnabled !== 'boolean')
        throw new Error('TOURNAMENT_RESPONSE_INVALID');
      const valid = r.result === null ? null : this.result(id, r.result, c ?? undefined);
      if (c && valid) this.save(id, c, valid);
      return { commandsEnabled: r.commandsEnabled, result: valid };
    });
  }
  async submit(id: string, input: TournamentLocalInput): Promise<TournamentLocalResult> {
    this.current();
    return this.locks.request(this.name(id), { mode: 'exclusive' }, async () => {
      this.current();
      if (!this.gateway.commandTournament) throw new Error('TOURNAMENT_UNAVAILABLE');
      const parsed = parseTournamentLocalInput(input),
        old = this.load(id);
      if (old && JSON.stringify(old.input) !== JSON.stringify(parsed))
        throw new Error('TOURNAMENT_PENDING');
      const c = old ?? {
        version: 1 as const,
        tournamentId: id,
        key: crypto.randomUUID(),
        input: parsed,
      };
      this.current();
      this.storage.setItem(this.name(id), JSON.stringify(c));
      this.current();
      const r = this.result(id, await this.gateway.commandTournament(id, c.input, c.key), c);
      this.current();
      this.save(id, c, r);
      return r;
    });
  }
  async retry(id: string, current: TournamentLocalResult | null): Promise<TournamentLocalResult> {
    this.current();
    const old = this.load(id);
    if (old && !old.operationId) return this.submit(id, old.input);
    return this.locks.request(this.name(id), { mode: 'exclusive' }, async () => {
      this.current();
      const c = this.load(id),
        op = c?.operationId ?? current?.operation.id;
      if (!op || !tournamentUuid(op) || !this.gateway.retryTournament)
        throw new Error('TOURNAMENT_RECOVERY_UNAVAILABLE');
      this.current();
      const r = this.result(id, await this.gateway.retryTournament(id, op, op), c ?? undefined);
      this.current();
      if (r.operation.id !== op) throw new Error('TOURNAMENT_RESPONSE_INVALID');
      if (c) this.save(id, c, r);
      return r;
    });
  }
}
