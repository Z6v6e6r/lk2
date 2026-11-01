import {
  TournamentLocalError,
  parseTournamentLocalInput,
  tournamentDigest,
  parseTournamentReceipt,
  type TournamentLocalInput,
  type TournamentLocalResult,
} from '@phub/domain';
import {
  sameTournamentIdentity,
  tournamentOwnerKey,
  type TournamentLocalRepository,
  type TournamentActor,
  type TournamentAttempt,
} from '@phub/database';
import type { TournamentLocalOwnerClient } from '@phub/legacy-games-adapter';
export function createTournamentLocalRuntime(options: {
  enabled: boolean;
  repository: TournamentLocalRepository;
  client?: Pick<TournamentLocalOwnerClient, 'identity' | 'prepare' | 'command' | 'read'>;
  token?: (actor: TournamentActor) => Promise<string>;
  date?: (id: string) => Promise<string>;
}) {
  const repo = options.repository;
  const scope = (a: TournamentActor, id: string) => ({
    tenantId: a.tenantId,
    userId: a.userId,
    tournamentId: id,
  });
  function view(
    x: TournamentAttempt,
    observation?: Awaited<ReturnType<TournamentLocalOwnerClient['read']>>,
  ): TournamentLocalResult {
    return {
      tournamentId: x.tournamentId,
      operation: {
        id: x.id,
        action: x.request.action,
        status: x.receipt?.operation.outcome ?? 'UNKNOWN',
        reason: x.receipt?.operation.reason ?? null,
        generation:
          x.receipt?.operation.outcome === 'REGISTERED'
            ? x.id
            : x.receipt?.operation.outcome === 'LEFT'
              ? x.originalJoinId
              : null,
      },
      registration: observation?.registration ?? { status: 'UNKNOWN', asOf: null },
      retryAfterSeconds: observation && x.receipt ? null : 15,
    };
  }
  async function identity(a: TournamentActor, x?: TournamentAttempt) {
    if (!options.enabled || !options.client || !options.token)
      throw new TournamentLocalError('TOURNAMENT_LOCAL_DISABLED');
    const ctx = await repo.context(a);
    if (!ctx || (x && !sameTournamentIdentity(ctx, x.identity)))
      throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
    const token = await options.token(a);
    const verified = await options.client.identity(token, a.correlationId);
    if (verified.tenantKey !== ctx.providerTenantKey || verified.clientId !== ctx.providerClientId)
      throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
    return { ctx, token };
  }
  async function observe(a: TournamentActor, x: TournamentAttempt, token: string) {
    try {
      const r = await options.client!.read(token, x.command, x.ownerOperationId, a.correlationId);
      if (!x.receipt) return view(x);
      if (JSON.stringify(r.operation) !== JSON.stringify(x.receipt.operation))
        throw new TournamentLocalError('TOURNAMENT_LOCAL_RECEIPT_CONFLICT', 409);
      return view(x, r);
    } catch (error) {
      if (
        error instanceof TournamentLocalError &&
        error.code === 'TOURNAMENT_LOCAL_RECEIPT_CONFLICT'
      )
        throw error;
      return view(x);
    }
  }
  async function dispatch(a: TournamentActor, x: TournamentAttempt, token: string) {
    if (x.receipt) return observe(a, x, token);
    const lease = await repo.claim(a, scope(a, x.tournamentId), x.id);
    if (!lease) return view(x);
    try {
      // Explicit POST only: original immutable command and backend key, never preparation/re-target.
      const r = parseTournamentReceipt(
        await options.client!.command(
          token,
          tournamentOwnerKey(x.id),
          x.command,
          x.ownerOperationId,
          a.correlationId,
        ),
        x.command,
        x.ownerOperationId,
      );
      const done = await repo.complete(a, scope(a, x.tournamentId), x.id, lease, r);
      if (!done) return view(x);
      return observe(a, done, token);
    } catch {
      return view({ ...x, state: 'DISPATCHED' });
    }
  }
  return {
    async execute(a: TournamentActor, id: string, key: string, raw: TournamentLocalInput) {
      if (!options.enabled) throw new TournamentLocalError('TOURNAMENT_LOCAL_DISABLED');
      if (!(await repo.ready())) throw new TournamentLocalError();
      const input = parseTournamentLocalInput(raw),
        keyHash = await tournamentDigest('lk2-tournament-key:v1', key);
      const old = await repo.read(scope(a, id), { keyHash });
      if (old) {
        if (JSON.stringify(old.request) !== JSON.stringify(input))
          throw new TournamentLocalError('TOURNAMENT_LOCAL_KEY_CONFLICT', 409);
        const i = await identity(a, old);
        return dispatch(a, old, i.token);
      }
      const i = await identity(a);
      let date: string;
      if (input.action === 'JOIN') {
        if (!options.date) throw new TournamentLocalError();
        date = await options.date(id);
        await options.client!.prepare(i.token, id, date, a.correlationId);
      } else {
        const original = await repo.read(scope(a, id), { id: input.originalJoinOperationId! });
        if (
          !original ||
          original.request.action !== 'JOIN' ||
          original.receipt?.operation.outcome !== 'REGISTERED' ||
          !sameTournamentIdentity(original.identity, i.ctx)
        )
          throw new TournamentLocalError('TOURNAMENT_LOCAL_ORIGINAL_REQUIRED', 409);
        date = original.command.date;
      }
      const x = await repo.begin(a, id, keyHash, input, i.ctx, date);
      if (!sameTournamentIdentity(x.identity, i.ctx))
        throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
      return dispatch(a, x, i.token);
    },
    async retry(a: TournamentActor, id: string, operationId: string) {
      if (!(await repo.ready())) throw new TournamentLocalError();
      const x = await repo.read(scope(a, id), { id: operationId });
      if (!x) throw new TournamentLocalError('TOURNAMENT_LOCAL_NOT_FOUND', 404);
      const i = await identity(a, x);
      return dispatch(a, x, i.token);
    },
    async read(a: TournamentActor, id: string, selector: { id?: string; key?: string } = {}) {
      if (!(await repo.ready())) return { commandsEnabled: false, result: null };
      const x = await repo.read(
        scope(a, id),
        selector.id
          ? { id: selector.id }
          : selector.key
            ? { keyHash: await tournamentDigest('lk2-tournament-key:v1', selector.key) }
            : {},
      );
      if (!x) {
        if (!options.enabled) return { commandsEnabled: false, result: null };
        await identity(a);
        return { commandsEnabled: true, result: null };
      }
      if (selector.id && selector.key) {
        const keyed = await repo.read(scope(a, id), {
          keyHash: await tournamentDigest('lk2-tournament-key:v1', selector.key),
        });
        if (keyed?.id !== x.id)
          throw new TournamentLocalError('TOURNAMENT_LOCAL_KEY_CONFLICT', 409);
      }
      // Disabled runtime may expose historical own receipt, never claim fresh registration.
      if (!options.enabled) return { commandsEnabled: false, result: view(x) };
      const i = await identity(a, x);
      if (!selector.id && !selector.key && x.receipt?.operation.outcome === 'REJECTED') {
        const original = await repo.registeredJoinCandidate(scope(a, id));
        if (original && sameTournamentIdentity(original.identity, i.ctx)) {
          const observed = await observe(a, original, i.token);
          if (
            observed.operation.status === 'REGISTERED' &&
            observed.registration.status === 'REGISTERED'
          )
            return { commandsEnabled: true, result: observed };
        }
      }
      return { commandsEnabled: true, result: await observe(a, x, i.token) };
    },
  };
}
export type TournamentLocalRuntime = ReturnType<typeof createTournamentLocalRuntime>;
