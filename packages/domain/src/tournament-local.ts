/** Concrete CUP LOCAL_ONLY tournament wire. No provider identifiers enter public results. */
export class TournamentLocalError extends Error {
  constructor(
    public readonly code = 'TOURNAMENT_LOCAL_UNAVAILABLE',
    public readonly status = 503,
  ) {
    super(code);
  }
}
export const tournamentUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v) &&
  v.length === 36;
export const tournamentKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(v) && !/[\r\n]/.test(v);
export function tournamentDate(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    v.length === 10 &&
    Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v
  );
}
export function tournamentObject(v: unknown, keys: string): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).sort().join(',') === keys.split(',').sort().join(',')
  );
}
export interface TournamentOwnerCommand {
  schemaVersion: 1;
  action: 'JOIN' | 'LEAVE';
  tournamentId: string;
  date: string;
  originalJoinOperationId?: string;
}
export interface TournamentLocalInput {
  action: 'JOIN' | 'LEAVE';
  originalJoinOperationId?: string;
}
export interface TournamentOwnerReceipt {
  schemaVersion: 1;
  tournamentId: string;
  operation: {
    operationId: string;
    action: 'JOIN' | 'LEAVE';
    outcome: 'REGISTERED' | 'LEFT' | 'REJECTED';
    reason: 'REGISTERED' | 'LEFT' | 'FULL' | 'MEMBERSHIP_EXISTS' | 'GENERATION_NOT_CURRENT';
    generation: string | null;
    committedAt: string;
  };
  registration: { status: 'REGISTERED' | 'NOT_REGISTERED_BY_OPERATION' | 'UNKNOWN'; asOf: string };
}
export interface TournamentLocalResult {
  tournamentId: string;
  operation: {
    id: string;
    action: 'JOIN' | 'LEAVE';
    status: 'UNKNOWN' | 'REGISTERED' | 'LEFT' | 'REJECTED';
    reason: string | null;
    generation: string | null;
  };
  registration: {
    status: 'REGISTERED' | 'NOT_REGISTERED_BY_OPERATION' | 'UNKNOWN';
    asOf: string | null;
  };
  retryAfterSeconds: number | null;
}
export function parseTournamentLocalInput(v: unknown): TournamentLocalInput {
  if (!v || typeof v !== 'object')
    throw new TournamentLocalError('TOURNAMENT_LOCAL_INPUT_INVALID', 400);
  const x = v as Record<string, unknown>;
  if (x.action === 'JOIN' && tournamentObject(x, 'action')) return { action: 'JOIN' };
  if (
    x.action === 'LEAVE' &&
    tournamentObject(x, 'action,originalJoinOperationId') &&
    tournamentUuid(x.originalJoinOperationId)
  )
    return { action: 'LEAVE', originalJoinOperationId: x.originalJoinOperationId };
  throw new TournamentLocalError('TOURNAMENT_LOCAL_INPUT_INVALID', 400);
}
export function parseTournamentCommand(v: unknown): TournamentOwnerCommand {
  if (!v || typeof v !== 'object') throw new TournamentLocalError();
  const x = v as Record<string, unknown>;
  const input = parseTournamentLocalInput({
    action: x.action,
    ...(x.action === 'LEAVE' ? { originalJoinOperationId: x.originalJoinOperationId } : {}),
  });
  if (
    !tournamentObject(
      x,
      input.action === 'JOIN'
        ? 'schemaVersion,action,tournamentId,date'
        : 'schemaVersion,action,tournamentId,date,originalJoinOperationId',
    ) ||
    x.schemaVersion !== 1 ||
    !tournamentUuid(x.tournamentId) ||
    !tournamentDate(x.date)
  )
    throw new TournamentLocalError();
  return {
    schemaVersion: 1,
    action: input.action,
    tournamentId: x.tournamentId,
    date: x.date,
    ...(input.originalJoinOperationId
      ? { originalJoinOperationId: input.originalJoinOperationId }
      : {}),
  };
}
export async function tournamentDigest(domain: string, value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(domain + '\0')
    .update(JSON.stringify(value))
    .digest('hex');
}
export async function tournamentOwnerOperationId(
  tenant: string,
  clientId: string,
  key: string,
  tournamentId: string,
): Promise<string> {
  const actor = await tournamentDigest('tournament-local-actor:v1', [tenant, clientId]);
  const kh = await tournamentDigest('tournament-local-key:v1', [tenant, actor, tournamentId, key]);
  const h = await tournamentDigest('tournament-local-operation:v1', kh);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function parseTournamentReceipt(
  v: unknown,
  command: TournamentOwnerCommand,
  operationId: string,
  now = Date.now(),
): TournamentOwnerReceipt {
  const bad = () => {
    throw new TournamentLocalError('TOURNAMENT_LOCAL_RECEIPT_INVALID');
  };
  if (
    !tournamentObject(v, 'schemaVersion,tournamentId,operation,registration') ||
    v.schemaVersion !== 1 ||
    v.tournamentId !== command.tournamentId
  )
    return bad();
  const o = v.operation,
    r = v.registration;
  if (
    !tournamentObject(o, 'operationId,action,outcome,reason,generation,committedAt') ||
    !tournamentObject(r, 'status,asOf') ||
    o.operationId !== operationId ||
    o.action !== command.action
  )
    return bad();
  const time = (s: unknown) =>
    typeof s === 'string' &&
    s.length <= 40 &&
    Number.isFinite(Date.parse(s)) &&
    Date.parse(s) <= now + 5000;
  if (
    !time(o.committedAt) ||
    !time(r.asOf) ||
    Date.parse(r.asOf as string) < Date.parse(o.committedAt as string) ||
    !['REGISTERED', 'NOT_REGISTERED_BY_OPERATION', 'UNKNOWN'].includes(r.status as string)
  )
    return bad();
  if (o.outcome === 'REGISTERED') {
    if (command.action !== 'JOIN' || o.reason !== 'REGISTERED' || o.generation !== operationId)
      return bad();
  } else if (o.outcome === 'LEFT') {
    if (
      command.action !== 'LEAVE' ||
      o.reason !== 'LEFT' ||
      o.generation !== command.originalJoinOperationId
    )
      return bad();
  } else if (o.outcome === 'REJECTED') {
    if (
      o.generation !== null ||
      !(
        command.action === 'JOIN' ? ['FULL', 'MEMBERSHIP_EXISTS'] : ['GENERATION_NOT_CURRENT']
      ).includes(o.reason as string)
    )
      return bad();
  } else return bad();
  return {
    schemaVersion: 1,
    tournamentId: command.tournamentId,
    operation: {
      operationId,
      action: command.action,
      outcome: o.outcome,
      reason: o.reason as TournamentOwnerReceipt['operation']['reason'],
      generation: o.generation as string | null,
      committedAt: o.committedAt as string,
    },
    registration: {
      status: r.status as TournamentOwnerReceipt['registration']['status'],
      asOf: r.asOf as string,
    },
  };
}

export interface TournamentLocalStatus {
  commandsEnabled: boolean;
  result: TournamentLocalResult | null;
}
