import { managedSelfLeaveFixture as f } from '../../subscription-runtime-adapter/src/managed-self-leave.test-fixture.js';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { managedSelfLeaveOperationId, managedSelfLeaveReceiptSha256 } from '@phub/domain';
import { createManagedSelfLeaveRepository } from './managed-self-leave-repository.js';
const digest = (v: string) => 'sha256:' + createHash('sha256').update(v).digest('hex');
async function stored() {
  const key = 'synthetic-self-leave-key';
  const keyHash = digest(key);
  const operationId = await managedSelfLeaveOperationId({
    ...f.identity,
    idempotencyKeySha256: keyHash,
  });
  const authority = {
    ...f.identity,
    operationId,
    idempotencyKeySha256: keyHash,
    request: f.request,
    requestSha256: f.requestSha256,
    originalJoinReceipt: f.originalJoinReceipt,
    legacyGameId: f.confirmed.receipt.legacyGameId,
    legacyGameMappingId: f.confirmed.receipt.legacyGameMappingId,
    legacyGameMappingVersion: f.confirmed.receipt.legacyGameMappingVersion,
  };
  const evidence = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const receipt = { ...f.confirmed.receipt, operationId, idempotencyKeySha256: keyHash };
  return {
    tenant_id: f.identity.tenantId,
    user_id: f.identity.userId,
    id: operationId,
    game_id: f.request.target.id,
    participation_id: f.request.participationId,
    reservation_id: f.request.reservationId,
    join_operation_id: f.request.joinOperationId,
    eligibility_decision_id: decision,
    evidence_id: evidence,
    authority,
    binding_sha256: digest(
      JSON.stringify([
        operationId,
        authority.tenantId,
        authority.userId,
        authority.requestSha256,
        keyHash,
        f.request.joinReceiptSha256,
        authority.legacyGameId,
        authority.legacyGameMappingId,
        authority.legacyGameMappingVersion,
        decision,
        evidence,
      ]),
    ),
    state: 'COMPLETED',
    receipt,
    receipt_sha256: await managedSelfLeaveReceiptSha256(receipt),
    command_state: 'COMPLETED',
    result_payload: {
      outcome: 'applied',
      commandId: operationId,
      gameId: f.request.target.id,
      participationId: f.request.participationId,
      revision: 9,
      viewerRelation: 'NONE',
    },
    idempotency_key: key,
    request_hash: 'a'.repeat(64),
    created_at: '2026-10-31T15:00:00.000Z',
    updated_at: '2026-10-31T15:00:00.000Z',
  };
}
function database(row: unknown, present = true) {
  const query = vi.fn((text: string) =>
    Promise.resolve().then(() => {
      if (text.includes('to_regclass'))
        return { rows: [{ present: present ? 'games.managed_self_leave_attempts' : null }] };
      if (text.includes('select a.*')) return { rows: row ? [row] : [] };
      return { rows: [] };
    }),
  );
  const pool = { connect: () => Promise.resolve().then(() => ({ query, release: vi.fn() })) };
  return { query, repository: createManagedSelfLeaveRepository(pool as never) };
}
describe('SELF immutable database replay validation', () => {
  it('replays JSONB terminal without selecting current participation or mappings', async () => {
    const row = await stored();
    const d = database(JSON.parse(JSON.stringify(row)));
    expect(
      (
        await d.repository.read({
          tenantId: row.tenant_id,
          actorUserId: row.user_id,
          operationId: row.id,
        })
      )?.state,
    ).toBe('COMPLETED');
    expect(
      d.query.mock.calls.some(([sql]) =>
        /from games.participations|external_entity_map|update |insert /i.test(sql),
      ),
    ).toBe(false);
  });
  it.each([
    'tenant_id',
    'user_id',
    'game_id',
    'participation_id',
    'reservation_id',
    'join_operation_id',
    'evidence_id',
    'eligibility_decision_id',
  ])('denies relational %s tampering before replay', async (key) => {
    const row = await stored();
    const d = database({ ...row, [key]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    await expect(
      d.repository.read({ tenantId: row.tenant_id, actorUserId: row.user_id, operationId: row.id }),
    ).rejects.toThrow();
  });
  it('denies complete-state forged receipt and hash even if stored together', async () => {
    const row = await stored();
    row.receipt.providerMappingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    row.receipt_sha256 = await managedSelfLeaveReceiptSha256(row.receipt);
    await expect(
      database(row).repository.read({
        tenantId: row.tenant_id,
        actorUserId: row.user_id,
        operationId: row.id,
      }),
    ).rejects.toThrow();
  });
  it('only genuinely absent table falls through; permission/connection errors propagate', async () => {
    const row = await stored();
    const missing = database(null, false);
    expect(
      await missing.repository.read({
        tenantId: row.tenant_id,
        actorUserId: row.user_id,
        operationId: row.id,
      }),
    ).toBeNull();
    const failed = database(row);
    failed.query.mockRejectedValueOnce(new Error('permission denied'));
    await expect(
      failed.repository.read({
        tenantId: row.tenant_id,
        actorUserId: row.user_id,
        operationId: row.id,
      }),
    ).rejects.toThrow('permission denied');
  });
});

const lookup = {
  tenantId: f.identity.tenantId,
  actorUserId: f.identity.userId,
  gameId: f.request.target.id,
  idempotencyKey: 'synthetic-recovery-original',
  requestHash: 'b'.repeat(64),
  correlationId: 'synthetic-recovery',
};
function ordinaryRow() {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    tenant_id: lookup.tenantId,
    actor_user_id: lookup.actorUserId,
    principal_key: 'user:' + lookup.actorUserId,
    idempotency_key: lookup.idempotencyKey,
    command_type: 'game.leave.v1',
    aggregate_id: lookup.gameId,
    request_hash: lookup.requestHash,
    state: 'FAILED',
    error_code: 'GAME_PAYMENT_REQUIRED',
    result_payload: null as unknown,
    created_at: '2026-10-31T10:00:00.000Z',
    completed_at: '2026-10-31T10:00:00.000Z' as string | null,
  };
}
function journal(
  row: ReturnType<typeof ordinaryRow> | null = null,
  linked = false,
  pending = false,
) {
  let stored = row;
  const query = vi.fn((sql: string, values: unknown[] = []) =>
    Promise.resolve().then(() => {
      if (sql.includes('to_regclass'))
        return { rows: [{ present: 'games.managed_self_leave_attempts' }] };
      if (sql.includes('select * from games.command_idempotency'))
        return { rows: stored ? [stored] : [] };
      if (sql.includes('union all select attempt_id'))
        return { rows: linked ? [{ id: 'linked' }] : [] };
      if (sql.includes('select revision from games.games')) return { rows: [{ revision: 4 }] };
      if (sql.includes("state <> 'COMPLETED'")) return { rows: pending ? [{ id: 'pending' }] : [] };
      if (sql.startsWith('insert into games.command_idempotency')) {
        stored = {
          ...ordinaryRow(),
          id: values[1] as string,
          error_code: 'GAME_NOT_LEAVABLE',
          result_payload: JSON.parse(values[7] as string),
        };
        return { rows: [stored] };
      }
      if (sql.startsWith('update games.command_idempotency')) {
        stored = { ...stored!, result_payload: JSON.parse(values[3] as string) };
        return { rows: [stored] };
      }
      return { rows: [] };
    }),
  );
  const repository = createManagedSelfLeaveRepository({
    connect: () => Promise.resolve({ query, release: vi.fn() }),
  } as never);
  return { query, repository, get: () => stored };
}
describe('SELF no-dispatch journal evidence', () => {
  it('fences absent original command, audits atomically, keeps immutable proof on replay', async () => {
    const x = journal();
    const result = await x.repository.reconcileUndispatched(lookup);
    expect(result?.kind).toBe('NOT_DISPATCHED');
    const original = structuredClone(x.get());
    expect(x.query.mock.calls.findIndex(([s]) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      x.query.mock.calls.findIndex(([s]) => s.includes('for update')),
    );
    expect(x.query.mock.calls.some(([s]) => s.includes('insert into audit.audit_log'))).toBe(true);
    expect(
      x.query.mock.calls.some(([s]) => s.includes('audit.game_self_leave_not_dispatched.v1')),
    ).toBe(true);
    x.query.mockClear();
    expect(await x.repository.reconcileUndispatched(lookup)).toEqual(result);
    expect(x.get()).toEqual(original);
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it('certifies only source-proven ordinary payment refusal, retaining original identity and times', async () => {
    const row = ordinaryRow(),
      x = journal(row);
    const result = await x.repository.reconcileUndispatched(lookup);
    expect(result?.kind).toBe('NOT_DISPATCHED');
    expect(x.get()).toMatchObject({
      ...row,
      result_payload: expect.objectContaining({ basis: 'ORDINARY_PAYMENT_REQUIRED' }) as unknown,
    });
    x.query.mockClear();
    expect(await x.repository.readCommand(lookup)).toEqual(result);
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it.each([
    { error_code: 'GAME_NOT_LEAVABLE' },
    { result_payload: {} },
    { result_payload: [] },
    { result_payload: { kind: 'other' } },
    { state: 'IN_PROGRESS' },
    { completed_at: null },
    { completed_at: 'malformed' },
    { command_type: 'game.join.v1' },
    { actor_user_id: 'foreign' },
    { tenant_id: 'foreign' },
    { principal_key: 'system:legacy' },
    { aggregate_id: 'foreign' },
    { request_hash: 'c'.repeat(64) },
  ])('does not infer authority from corrupt or generic historical state %j', async (change) => {
    const x = journal({ ...ordinaryRow(), ...change });
    await expect(x.repository.reconcileUndispatched(lookup)).rejects.toThrow();
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it('managed link or dangling canonical attempt always wins over a generic failure', async () => {
    const x = journal(ordinaryRow(), true);
    expect(await x.repository.reconcileUndispatched(lookup)).toBeNull();
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it('another unresolved generation cannot be certified as safe to replace', async () => {
    const x = journal(null, false, true);
    await expect(x.repository.reconcileUndispatched(lookup)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it('same-key changed public request never replays or replaces terminal evidence', async () => {
    const x = journal();
    await x.repository.reconcileUndispatched(lookup);
    x.query.mockClear();
    await expect(
      x.repository.reconcileUndispatched({ ...lookup, requestHash: 'c'.repeat(64) }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(x.query.mock.calls.some(([s]) => /insert |update games/.test(s))).toBe(false);
  });
  it('read denies tampered exact proof instead of exposing an erasure signal', async () => {
    const x = journal();
    await x.repository.reconcileUndispatched(lookup);
    Object.assign(x.get()!.result_payload as object, {
      idempotencyKeySha256: 'sha256:' + '0'.repeat(64),
    });
    await expect(x.repository.readCommand(lookup)).rejects.toThrow(
      'MANAGED_SELF_LEAVE_BINDING_INVALID',
    );
  });
});
