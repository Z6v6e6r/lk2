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
