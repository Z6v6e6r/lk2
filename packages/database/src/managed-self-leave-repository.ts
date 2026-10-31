import type { Pool, PoolClient } from 'pg';
import {
  assertManagedSelfLeaveAuthority,
  managedSelfLeaveJoinReceiptSha256,
  managedSelfLeaveOperationId,
  managedSelfLeaveRequestSha256,
  managedSelfLeaveReceiptSha256,
  managedSelfLeaveReceiptMatches,
  parseManagedSelfLeaveReceipt,
  type ManagedSelfLeaveAuthority,
  type ManagedSelfLeaveReceipt,
} from '@phub/domain';
import { queryOne, withTenantTransaction } from './connection.js';
import {
  loadManagedSelfLeaveJoinAuthority,
  finalizeManagedSelfLeaveParticipation,
  type GameRosterCommandResult,
} from './game-roster-repository.js';

export class ManagedSelfLeaveError extends Error {
  constructor(
    public readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'GAME_NOT_FOUND'
      | 'GAME_REVISION_CONFLICT'
      | 'GAME_PAYMENT_REQUIRED'
      | 'GAME_NOT_LEAVABLE'
      | 'MANAGED_SELF_LEAVE_BINDING_INVALID',
  ) {
    super(code);
  }
}
export interface ManagedSelfLeaveInput {
  tenantId: string;
  actorUserId: string;
  gameId: string;
  idempotencyKey: string;
  requestHash: string;
  correlationId: string;
  expectedRevision?: number;
  providerClientId?: string;
  providerMappingId?: string;
}
export interface ManagedSelfLeaveAttempt {
  createdAt: string;
  updatedAt: string;
  authority: ManagedSelfLeaveAuthority;
  idempotencyKey: string;
  state: 'PREPARED' | 'DISPATCH_STARTED' | 'COMPLETED';
  receipt: ManagedSelfLeaveReceipt | null;
  result: Extract<GameRosterCommandResult, { outcome: 'applied' }> | null;
}
/** Local command evidence only; never asserts current membership or a provider cancellation. */
export interface SelfLeaveCommandEvidence {
  kind: 'NOT_DISPATCHED' | 'APPLIED';
  commandId: string;
  gameId: string;
  revision: number;
  createdAt: string;
  completedAt: string;
  idempotencyKeySha256: string;
}
type CommandLookup = Pick<
  ManagedSelfLeaveInput,
  'tenantId' | 'actorUserId' | 'gameId' | 'idempotencyKey'
>;
export interface ManagedSelfLeaveRepository {
  isNoPayment(input: Pick<ManagedSelfLeaveInput, 'tenantId' | 'gameId'>): Promise<boolean>;
  readCommand(input: CommandLookup): Promise<SelfLeaveCommandEvidence | null>;
  reconcileUndispatched(input: ManagedSelfLeaveInput): Promise<SelfLeaveCommandEvidence | null>;
  begin(input: ManagedSelfLeaveInput): Promise<ManagedSelfLeaveAttempt | null>;
  read(input: {
    tenantId: string;
    actorUserId: string;
    operationId: string;
  }): Promise<ManagedSelfLeaveAttempt | null>;
  readByKey(input: {
    tenantId: string;
    actorUserId: string;
    gameId: string;
    idempotencyKey: string;
  }): Promise<ManagedSelfLeaveAttempt | null>;
  claim(input: { tenantId: string; actorUserId: string; operationId: string }): Promise<{
    attempt: ManagedSelfLeaveAttempt;
    leaseToken: string;
    recoveryOnly: boolean;
  } | null>;
  finalize(input: {
    tenantId: string;
    actorUserId: string;
    operationId: string;
    receipt: ManagedSelfLeaveReceipt;
    correlationId: string;
  }): Promise<ManagedSelfLeaveAttempt>;
}
interface Row {
  created_at: Date | string;
  updated_at: Date | string;
  tenant_id: string;
  id: string;
  game_id: string;
  user_id: string;
  participation_id: string;
  reservation_id: string;
  eligibility_decision_id: string;
  evidence_id: string;
  join_operation_id: string;
  authority: ManagedSelfLeaveAuthority;
  binding_sha256: string;
  state: ManagedSelfLeaveAttempt['state'];
  receipt: ManagedSelfLeaveReceipt | null;
  receipt_sha256: string | null;
  idempotency_key: string;
  request_hash: string;
  command_state: string;
  result_payload: ManagedSelfLeaveAttempt['result'];
}
const invalid = (): never => {
  throw new ManagedSelfLeaveError('MANAGED_SELF_LEAVE_BINDING_INVALID');
};
const select = `select a.*,c.idempotency_key,c.request_hash,c.state as command_state,c.result_payload from games.managed_self_leave_attempts a join games.command_idempotency c on c.tenant_id=a.tenant_id and c.id=a.id and c.actor_user_id=a.user_id and c.aggregate_id=a.game_id and c.command_type='game.leave.v1' and c.principal_key='user:'||a.user_id::text`;
async function present(client: PoolClient): Promise<boolean> {
  return Boolean(
    (
      await queryOne<{ present: string | null }>(
        client,
        "select to_regclass('games.managed_self_leave_attempts')::text as present",
      )
    )?.present,
  );
}
async function digest(s: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}
async function binding(
  a: ManagedSelfLeaveAuthority,
  row: Pick<Row, 'eligibility_decision_id' | 'evidence_id'>,
): Promise<string> {
  await assertManagedSelfLeaveAuthority(a);
  return await digest(
    JSON.stringify([
      a.operationId,
      a.tenantId,
      a.userId,
      a.requestSha256,
      a.idempotencyKeySha256,
      await managedSelfLeaveJoinReceiptSha256(a.originalJoinReceipt),
      a.legacyGameId,
      a.legacyGameMappingId,
      a.legacyGameMappingVersion,
      row.eligibility_decision_id,
      row.evidence_id,
    ]),
  );
}
async function view(row: Row): Promise<ManagedSelfLeaveAttempt> {
  const a = row.authority;
  await assertManagedSelfLeaveAuthority(a);
  if (
    a.tenantId !== row.tenant_id ||
    a.userId !== row.user_id ||
    a.operationId !== row.id ||
    a.request.target.id !== row.game_id ||
    a.request.participationId !== row.participation_id ||
    a.request.reservationId !== row.reservation_id ||
    a.request.joinOperationId !== row.join_operation_id ||
    a.idempotencyKeySha256 !== (await digest(row.idempotency_key)) ||
    (await binding(a, row)) !== row.binding_sha256
  )
    return invalid();
  if (row.state === 'COMPLETED') {
    const r = parseManagedSelfLeaveReceipt(row.receipt);
    const result = row.result_payload;
    if (
      !managedSelfLeaveReceiptMatches(r, a) ||
      (await managedSelfLeaveReceiptSha256(r)) !== row.receipt_sha256 ||
      row.command_state !== 'COMPLETED' ||
      !result ||
      result.outcome !== 'applied' ||
      result.commandId !== row.id ||
      result.gameId !== row.game_id ||
      result.participationId !== row.participation_id ||
      result.viewerRelation !== 'NONE' ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 1
    )
      return invalid();
    return {
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      authority: a,
      idempotencyKey: row.idempotency_key,
      state: row.state,
      receipt: r,
      result,
    };
  }
  if (
    !['PREPARED', 'DISPATCH_STARTED'].includes(row.state) ||
    row.command_state !== 'IN_PROGRESS' ||
    row.receipt !== null ||
    row.result_payload !== null
  )
    return invalid();
  return {
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    authority: a,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    receipt: null,
    result: null,
  };
}
async function rowById(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
  id: string,
  lock = false,
): Promise<Row | undefined> {
  return queryOne<Row>(
    client,
    select + ` where a.tenant_id=$1 and a.user_id=$2 and a.id=$3${lock ? ' for update of a' : ''}`,
    [tenantId, actorUserId, id],
  );
}
interface Command {
  tenant_id: string;
  principal_key: string;
  idempotency_key: string;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  id: string;
  command_type: string;
  aggregate_id: string;
  actor_user_id: string;
  request_hash: string;
  state: string;
  result_payload: unknown;
}
async function linked(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
  command: Command,
  gameId?: string,
): Promise<Row> {
  if (
    command.command_type !== 'game.leave.v1' ||
    command.actor_user_id !== actorUserId ||
    (gameId !== undefined && command.aggregate_id !== gameId)
  )
    throw new ManagedSelfLeaveError('IDEMPOTENCY_CONFLICT');
  const link = await queryOne<{ attempt_id: string }>(
    client,
    `select attempt_id from games.managed_self_leave_command_links where tenant_id=$1 and command_id=$2`,
    [tenantId, command.id],
  );
  const row = link ? await rowById(client, tenantId, actorUserId, link.attempt_id) : undefined;
  if (!row || row.game_id !== command.aggregate_id) return invalid();
  const v = await view(row);
  if (
    command.state !== (v.state === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS') ||
    (v.state === 'COMPLETED' &&
      JSON.stringify(command.result_payload) !== JSON.stringify(row.result_payload))
  )
    return invalid();
  return row;
}
async function addCommand(
  client: PoolClient,
  input: ManagedSelfLeaveInput,
  id: string,
  result: ManagedSelfLeaveAttempt['result'] = null,
): Promise<void> {
  await client.query(
    `insert into games.command_idempotency(tenant_id,id,command_type,principal_key,actor_user_id,idempotency_key,request_hash,state,aggregate_id,result_payload,completed_at)
 values($1,$2,'game.leave.v1',$3,$4,$5,$6,$7,$8,$9::jsonb,case when $9::jsonb is null then null else now() end)`,
    [
      input.tenantId,
      id,
      'user:' + input.actorUserId,
      input.actorUserId,
      input.idempotencyKey,
      input.requestHash,
      result ? 'COMPLETED' : 'IN_PROGRESS',
      input.gameId,
      result ? JSON.stringify(result) : null,
    ],
  );
}
const refusalKind = 'GAME_SELF_LEAVE_NOT_DISPATCHED_V1';
function commandScope(command: Command, input: CommandLookup & { requestHash?: string }): void {
  if (
    command.tenant_id !== input.tenantId ||
    command.actor_user_id !== input.actorUserId ||
    command.principal_key !== 'user:' + input.actorUserId ||
    command.idempotency_key !== input.idempotencyKey ||
    command.aggregate_id !== input.gameId ||
    command.command_type !== 'game.leave.v1' ||
    (input.requestHash !== undefined && command.request_hash !== input.requestHash)
  )
    throw new ManagedSelfLeaveError('IDEMPOTENCY_CONFLICT');
}
async function commandEvidence(
  command: Command,
  input: CommandLookup,
): Promise<SelfLeaveCommandEvidence | null> {
  commandScope(command, input);
  const raw = command.result_payload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keyHash = await digest(input.idempotencyKey);
  const createdAt = new Date(command.created_at).toISOString();
  if (!command.completed_at) return invalid();
  const completedAt = new Date(command.completed_at).toISOString();
  if (completedAt < createdAt) return invalid();
  if (command.state === 'FAILED' && r.kind === refusalKind) {
    if (
      Object.keys(r).sort().join(',') !==
        [
          'kind',
          'basis',
          'tenantId',
          'actorUserId',
          'gameId',
          'commandId',
          'requestHash',
          'idempotencyKeySha256',
          'revision',
          'dispatchStarted',
        ]
          .sort()
          .join(',') ||
      r.tenantId !== input.tenantId ||
      r.actorUserId !== input.actorUserId ||
      r.gameId !== input.gameId ||
      r.commandId !== command.id ||
      r.requestHash !== command.request_hash ||
      r.idempotencyKeySha256 !== keyHash ||
      r.dispatchStarted !== false ||
      !(
        (r.basis === 'ABSENT_COMMAND' && command.error_code === 'GAME_NOT_LEAVABLE') ||
        (r.basis === 'ORDINARY_PAYMENT_REQUIRED' && command.error_code === 'GAME_PAYMENT_REQUIRED')
      ) ||
      !Number.isSafeInteger(r.revision) ||
      Number(r.revision) < 1
    )
      return invalid();
    return {
      kind: 'NOT_DISPATCHED',
      commandId: command.id,
      gameId: input.gameId,
      revision: Number(r.revision),
      createdAt,
      completedAt,
      idempotencyKeySha256: keyHash,
    };
  }
  if (command.state === 'COMPLETED') {
    if (
      command.error_code !== null ||
      r.outcome !== 'applied' ||
      r.commandId !== command.id ||
      r.gameId !== input.gameId ||
      r.viewerRelation !== 'NONE' ||
      !Number.isSafeInteger(r.revision) ||
      Number(r.revision) < 1 ||
      typeof r.participationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(r.participationId) ||
      typeof r.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(r.committedAt))
    )
      return invalid();
    return {
      kind: 'APPLIED',
      commandId: command.id,
      gameId: input.gameId,
      revision: Number(r.revision),
      createdAt,
      completedAt,
      idempotencyKeySha256: keyHash,
    };
  }
  return null;
}
async function commandByKey(client: PoolClient, input: CommandLookup, lock: 'share' | 'update') {
  return queryOne<Command>(
    client,
    `select * from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3 for ${lock}`,
    [input.tenantId, 'user:' + input.actorUserId, input.idempotencyKey],
  );
}
async function hasManagedLink(
  client: PoolClient,
  input: CommandLookup,
  command: Command,
): Promise<boolean> {
  // Check both directions: a corrupt missing link must never turn a dispatched attempt into refusal.
  return Boolean(
    await queryOne(
      client,
      `select id from games.managed_self_leave_attempts where tenant_id=$1 and id=$2
    union all select attempt_id as id from games.managed_self_leave_command_links where tenant_id=$1 and command_id=$2 limit 1`,
      [input.tenantId, command.id],
    ),
  );
}
export function createManagedSelfLeaveRepository(pool: Pool): ManagedSelfLeaveRepository {
  return {
    isNoPayment(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) =>
        Boolean(
          await queryOne(
            client,
            "select id from games.games where tenant_id=$1 and id=$2 and payment_mode='NO_PAYMENT'",
            [input.tenantId, input.gameId],
          ),
        ),
      );
    },
    readCommand(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await present(client))) return null;
        const command = await commandByKey(client, input, 'share');
        if (!command) return null;
        commandScope(command, input);
        if (await hasManagedLink(client, input, command)) return null;
        return commandEvidence(command, input);
      });
    },
    reconcileUndispatched(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await present(client))) throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
        if (
          !/^[a-f0-9]{64}$/.test(input.requestHash) ||
          input.idempotencyKey.length < 16 ||
          input.idempotencyKey.length > 128
        )
          return invalid();
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `game-command:${input.tenantId}:user:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const command = await commandByKey(client, input, 'update');
        if (command) {
          commandScope(command, input);
          if (await hasManagedLink(client, input, command)) return null;
          const evidence = await commandEvidence(command, input);
          if (evidence) return evidence;
          // Only this historical refusal has a source-proven pre-write ordinary owner (see games.md).
          // No generic FAILED inference, and no coercion of malformed/unknown persisted results.
          if (
            command.state !== 'FAILED' ||
            command.error_code !== 'GAME_PAYMENT_REQUIRED' ||
            command.result_payload !== null ||
            !command.completed_at ||
            !Number.isFinite(new Date(command.created_at).getTime()) ||
            !Number.isFinite(new Date(command.completed_at).getTime()) ||
            new Date(command.completed_at) < new Date(command.created_at)
          )
            throw new ManagedSelfLeaveError('GAME_NOT_LEAVABLE');
        }
        const game = await queryOne<{ revision: number | string }>(
          client,
          'select revision from games.games where tenant_id=$1 and id=$2 for update',
          [input.tenantId, input.gameId],
        );
        if (!game) throw new ManagedSelfLeaveError('GAME_NOT_FOUND');
        // A different original key may already own unresolved cancellation of this actor's membership.
        if (
          await queryOne(
            client,
            `select id from games.managed_self_leave_attempts where tenant_id=$1 and user_id=$2 and game_id=$3 and state <> 'COMPLETED' limit 1`,
            [input.tenantId, input.actorUserId, input.gameId],
          )
        )
          throw new ManagedSelfLeaveError('IDEMPOTENCY_CONFLICT');
        const { randomUUID } = await import('node:crypto');
        const id = command?.id ?? randomUUID();
        const proof = {
          kind: refusalKind,
          basis: command ? 'ORDINARY_PAYMENT_REQUIRED' : 'ABSENT_COMMAND',
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          gameId: input.gameId,
          commandId: id,
          requestHash: input.requestHash,
          idempotencyKeySha256: await digest(input.idempotencyKey),
          revision: Number(game.revision),
          dispatchStarted: false,
        };
        const stored = command
          ? await queryOne<Command>(
              client,
              `update games.command_idempotency set result_payload=$4::jsonb
              where tenant_id=$1 and id=$2 and request_hash=$3 and state='FAILED' and error_code='GAME_PAYMENT_REQUIRED'
              and result_payload is null and completed_at is not null returning *`,
              [input.tenantId, id, input.requestHash, JSON.stringify(proof)],
            )
          : await queryOne<Command>(
              client,
              `insert into games.command_idempotency
          (tenant_id,id,actor_user_id,principal_key,idempotency_key,command_type,request_hash,aggregate_id,state,error_code,result_payload,completed_at)
          values($1,$2,$3,$4,$5,'game.leave.v1',$6,$7,'FAILED','GAME_NOT_LEAVABLE',$8::jsonb,clock_timestamp()) returning *`,
              [
                input.tenantId,
                id,
                input.actorUserId,
                'user:' + input.actorUserId,
                input.idempotencyKey,
                input.requestHash,
                input.gameId,
                JSON.stringify(proof),
              ],
            );
        await client.query(
          `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,reason,correlation_id,new_value)
          values($1,$2,'GAME_SELF_LEAVE_NOT_DISPATCHED','GAME',$3,'REJECTED','NO_ORIGINAL_DISPATCH',$4,$5::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.gameId,
            input.correlationId,
            JSON.stringify({ commandId: id, revision: proof.revision }),
          ],
        );
        await client.query(
          `insert into audit.outbox_events(id,tenant_id,event_type,aggregate_id,correlation_id,payload,occurred_at)
          values($1,$2,'audit.game_self_leave_not_dispatched.v1',$3,$4,$5::jsonb,clock_timestamp())`,
          [
            randomUUID(),
            input.tenantId,
            input.gameId,
            input.correlationId,
            JSON.stringify({ commandId: id, userId: input.actorUserId }),
          ],
        );
        return stored ? commandEvidence(stored, input) : invalid();
      });
    },
    read(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await present(client))) return null;
        const row = await rowById(client, input.tenantId, input.actorUserId, input.operationId);
        return row ? view(row) : null;
      });
    },
    readByKey(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await present(client))) return null;
        const command = await queryOne<Command>(
          client,
          `select * from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3 for share`,
          [input.tenantId, 'user:' + input.actorUserId, input.idempotencyKey],
        );
        if (!command) return null;
        // Ordinary legacy commands have no concrete link and remain owned by the ordinary repository.
        const link = await queryOne(
          client,
          `select command_id from games.managed_self_leave_command_links where tenant_id=$1 and command_id=$2`,
          [input.tenantId, command.id],
        );
        if (!link) return null;
        return view(await linked(client, input.tenantId, input.actorUserId, command, input.gameId));
      });
    },
    begin(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await present(client))) throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
        if (
          !/^[a-f0-9]{64}$/.test(input.requestHash) ||
          input.idempotencyKey.length < 16 ||
          input.idempotencyKey.length > 128
        )
          return invalid();
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `game-command:${input.tenantId}:user:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const command = await queryOne<Command>(
          client,
          `select * from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3 for update`,
          [input.tenantId, 'user:' + input.actorUserId, input.idempotencyKey],
        );
        if (command) {
          if (
            command.request_hash !== input.requestHash ||
            command.command_type !== 'game.leave.v1' ||
            command.aggregate_id !== input.gameId
          )
            throw new ManagedSelfLeaveError('IDEMPOTENCY_CONFLICT');
          const link = await queryOne(
            client,
            `select command_id from games.managed_self_leave_command_links where tenant_id=$1 and command_id=$2`,
            [input.tenantId, command.id],
          );
          if (!link) return null;
          return view(
            await linked(client, input.tenantId, input.actorUserId, command, input.gameId),
          );
        }
        const game = await queryOne<{
          revision: string | number;
          payment_mode: string;
          lifecycle_state: string;
          future: boolean;
        }>(
          client,
          `select revision,payment_mode,lifecycle_state,starts_at>now() as future from games.games where tenant_id=$1 and id=$2 for update`,
          [input.tenantId, input.gameId],
        );
        if (!game) throw new ManagedSelfLeaveError('GAME_NOT_FOUND');
        if (game.payment_mode === 'NO_PAYMENT') return null;
        if (game.payment_mode !== 'SUBSCRIPTION')
          throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
        const participation = await queryOne<{
          id: string;
          role: string;
          eligibility_decision_id: string;
        }>(
          client,
          `select id,role,eligibility_decision_id from games.participations where tenant_id=$1 and game_id=$2 and user_id=$3 and state='ACTIVE' for update`,
          [input.tenantId, input.gameId, input.actorUserId],
        );
        if (!participation || participation.role !== 'PLAYER')
          throw new ManagedSelfLeaveError('GAME_NOT_LEAVABLE');
        const existing = await queryOne<Row>(
          client,
          select + ` where a.tenant_id=$1 and a.participation_id=$2 for update of a`,
          [input.tenantId, participation.id],
        );
        if (existing) {
          const original = await view(existing);
          if (existing.user_id !== input.actorUserId || existing.game_id !== input.gameId)
            return invalid();
          const { randomUUID } = await import('node:crypto');
          const aliasId = randomUUID();
          await addCommand(client, input, aliasId, original.result);
          await client.query(
            `insert into games.managed_self_leave_command_links(tenant_id,command_id,attempt_id) values($1,$2,$3)`,
            [input.tenantId, aliasId, existing.id],
          );
          return original;
        }
        if (game.lifecycle_state !== 'SCHEDULED' || !game.future)
          throw new ManagedSelfLeaveError('GAME_NOT_LEAVABLE');
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== Number(game.revision)
        )
          throw new ManagedSelfLeaveError('GAME_REVISION_CONFLICT');
        const original = await loadManagedSelfLeaveJoinAuthority(client, {
          ...input,
          participationId: participation.id,
          eligibilityDecisionId: participation.eligibility_decision_id,
        });
        if (
          !original ||
          original.receipt.providerClientId !== input.providerClientId ||
          original.receipt.providerMappingId !== input.providerMappingId
        )
          throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
        const maps = await client.query<{
          id: string;
          external_id: string;
          external_version: string;
        }>(
          `select id,external_id,external_version from integration.external_entity_map where tenant_id=$1 and internal_id=$2 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game' and sync_status='synced' and sync_error_code is null and last_synced_at is not null and external_version is not null`,
          [input.tenantId, input.gameId],
        );
        if (maps.rows.length !== 1) throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
        const map = maps.rows[0]!;
        const keyHash = await digest(input.idempotencyKey);
        const operationId = await managedSelfLeaveOperationId({
          tenantId: input.tenantId,
          userId: input.actorUserId,
          idempotencyKeySha256: keyHash,
        });
        const request = {
          contractVersion: 1 as const,
          action: 'LEAVE_GAME' as const,
          target: { id: input.gameId, expectedRevision: Number(game.revision) },
          participationId: participation.id,
          reservationId: original.reservationId,
          joinOperationId: original.receipt.operationId,
          joinReceiptSha256: await managedSelfLeaveJoinReceiptSha256(original.receipt),
          returnMode: 'SERVICE' as const,
        };
        const authority: ManagedSelfLeaveAuthority = {
          operationId,
          tenantId: input.tenantId,
          userId: input.actorUserId,
          request,
          requestSha256: await managedSelfLeaveRequestSha256(request),
          idempotencyKeySha256: keyHash,
          originalJoinReceipt: original.receipt,
          legacyGameId: map.external_id,
          legacyGameMappingId: map.id,
          legacyGameMappingVersion: map.external_version,
        };
        const bindingHash = await binding(authority, {
          eligibility_decision_id: original.eligibilityDecisionId,
          evidence_id: original.evidenceId,
        });
        await addCommand(client, input, operationId);
        await client.query(
          `insert into games.managed_self_leave_attempts(tenant_id,id,game_id,user_id,participation_id,reservation_id,eligibility_decision_id,evidence_id,join_operation_id,authority,binding_sha256) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
          [
            input.tenantId,
            operationId,
            input.gameId,
            input.actorUserId,
            participation.id,
            original.reservationId,
            original.eligibilityDecisionId,
            original.evidenceId,
            original.receipt.operationId,
            JSON.stringify(authority),
            bindingHash,
          ],
        );
        await client.query(
          `insert into games.managed_self_leave_command_links(tenant_id,command_id,attempt_id) values($1,$2,$2)`,
          [input.tenantId, operationId],
        );
        return view((await rowById(client, input.tenantId, input.actorUserId, operationId))!);
      });
    },
    claim(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await rowById(
          client,
          input.tenantId,
          input.actorUserId,
          input.operationId,
          true,
        );
        if (!row) return null;
        const attempt = await view(row);
        if (attempt.state === 'COMPLETED') return null;
        const { randomUUID } = await import('node:crypto');
        const token = randomUUID();
        const claimed = await client.query(
          `update games.managed_self_leave_attempts set state='DISPATCH_STARTED',dispatch_started_at=coalesce(dispatch_started_at,now()),lease_token=$4,lease_until=now()+interval '15 seconds',updated_at=now() where tenant_id=$1 and id=$2 and user_id=$3 and state in('PREPARED','DISPATCH_STARTED') and (lease_until is null or lease_until<=now()) returning id`,
          [input.tenantId, input.operationId, input.actorUserId, token],
        );
        return claimed.rowCount === 1
          ? { attempt, leaseToken: token, recoveryOnly: attempt.state !== 'PREPARED' }
          : null;
      });
    },
    finalize(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const initial = await rowById(client, input.tenantId, input.actorUserId, input.operationId);
        if (!initial) return invalid();
        await client.query(`select id from games.games where tenant_id=$1 and id=$2 for update`, [
          input.tenantId,
          initial.game_id,
        ]);
        const row = (await rowById(
          client,
          input.tenantId,
          input.actorUserId,
          input.operationId,
          true,
        ))!;
        const attempt = await view(row);
        const receipt = parseManagedSelfLeaveReceipt(input.receipt);
        if (
          !managedSelfLeaveReceiptMatches(receipt, attempt.authority) ||
          Date.parse(receipt.completedAt) > Date.now()
        )
          return invalid();
        const receiptHash = await managedSelfLeaveReceiptSha256(receipt);
        if (attempt.state === 'COMPLETED') {
          if (receiptHash !== row.receipt_sha256) return invalid();
          return attempt;
        }
        if (attempt.state !== 'DISPATCH_STARTED') return invalid();
        const original = await loadManagedSelfLeaveJoinAuthority(client, {
          tenantId: input.tenantId,
          gameId: row.game_id,
          actorUserId: input.actorUserId,
          participationId: row.participation_id,
          eligibilityDecisionId: row.eligibility_decision_id,
        });
        if (
          !original ||
          original.evidenceId !== row.evidence_id ||
          original.reservationId !== row.reservation_id ||
          (await managedSelfLeaveJoinReceiptSha256(original.receipt)) !==
            attempt.authority.request.joinReceiptSha256
        )
          return invalid();
        const result = await finalizeManagedSelfLeaveParticipation(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          gameId: row.game_id,
          idempotencyKey: row.idempotency_key,
          requestHash: row.request_hash,
          correlationId: input.correlationId,
          operationId: row.id,
          participationId: row.participation_id,
          eligibilityDecisionId: row.eligibility_decision_id,
        });
        const links = await client.query<{ command_id: string }>(
          `select command_id from games.managed_self_leave_command_links where tenant_id=$1 and attempt_id=$2`,
          [input.tenantId, row.id],
        );
        const updated = await client.query(
          `update games.command_idempotency c set state='COMPLETED',result_payload=$4::jsonb,completed_at=now() from games.managed_self_leave_command_links l where l.tenant_id=$1 and l.attempt_id=$2 and c.tenant_id=l.tenant_id and c.id=l.command_id and c.actor_user_id=$3 and c.principal_key='user:'||$3::text and c.aggregate_id=$5 and c.command_type='game.leave.v1' and c.state='IN_PROGRESS'`,
          [input.tenantId, row.id, input.actorUserId, JSON.stringify(result), row.game_id],
        );
        if (links.rows.length === 0 || updated.rowCount !== links.rows.length) return invalid();
        await client.query(
          `update games.managed_self_leave_attempts set state='COMPLETED',receipt=$3::jsonb,receipt_sha256=$4,completed_at=now(),lease_token=null,lease_until=null,updated_at=now() where tenant_id=$1 and id=$2 and state='DISPATCH_STARTED'`,
          [input.tenantId, row.id, JSON.stringify(receipt), receiptHash],
        );
        return view((await rowById(client, input.tenantId, input.actorUserId, row.id))!);
      });
    },
  };
}
