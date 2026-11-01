import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBookedOperationAdmissionTargetRepository } from './booked-operation-admission-target-repository.js';
const input = { tenantId: randomUUID(), targetId: randomUUID(), expectedRevision: 1 };
const actorUserId = randomUUID();
const draftInput = { ...input, action: 'CREATE_GAME' as const, actorUserId };
const row = {
  id: randomUUID(),
  external_id: 'synthetic-exercise',
  external_version: 'fixture-v1',
  starts_at: new Date('2099-01-01T09:00:00.000Z'),
  duration_minutes: '60',
  capacity: 4,
  admissible: true,
};
const draftRow = {
  id: input.targetId,
  revision: '1',
  starts_at: new Date('2099-01-01T09:00:00.000Z'),
  duration_minutes: '90',
  capacity: 4,
  payment_mode: 'SPLIT',
  admissible: true,
};
function fixture(joinRows: unknown[] = [], draftRows: unknown[] = []) {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>((sql) =>
    Promise.resolve({
      rows: sql.includes('integration.external_entity_map')
        ? joinRows
        : sql.includes('from games.games game')
          ? draftRows
          : [],
    }),
  );
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { query, pool };
}
// Simulates the tenant/scoped SQL filter: the row exists only for the exact tenant, draft id,
// expected revision and authenticated organizer passed as query parameters.
function draftFixture(
  expected: {
    tenantId: string;
    targetId: string;
    expectedRevision: number;
    actorUserId: string;
  } = draftInput,
  matchedRow: unknown = draftRow,
) {
  const query = vi.fn((sql: string, params?: unknown[]) =>
    Promise.resolve({
      rows:
        sql.includes('from games.games game') &&
        params !== undefined &&
        JSON.stringify(params) ===
          JSON.stringify([
            expected.tenantId,
            expected.targetId,
            expected.expectedRevision,
            expected.actorUserId,
          ])
          ? [matchedRow]
          : [],
    }),
  );
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { query, pool };
}
function queryFor(
  query: ReturnType<typeof fixture>['query'],
  marker: string,
): [sql: string, ...params: unknown[]] {
  const call = query.mock.calls.find(([sql]) => sql.includes(marker));
  if (!call) throw Error(`Query not found: ${marker}`);
  return call;
}
describe('admission canonical target repository', () => {
  it('uses bounded tenant RLS and stable mapping while separating mutable eligibility', async () => {
    const f = fixture([{ ...row, admissible: false }]);
    expect(
      await createBookedOperationAdmissionTargetRepository(f.pool as never).resolve(input),
    ).toMatchObject({ providerExerciseId: row.external_id, admissible: false });
    expect(f.query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      input.tenantId,
    ]);
    expect(f.query).toHaveBeenCalledWith("set local statement_timeout = '1500ms'");
    const sql = queryFor(f.query, 'integration.external_entity_map')[0];
    expect(sql).toContain("mapping.sync_status='synced'");
    expect(sql).toContain("mapping.entity_type='exercise'");
    expect(sql).toContain('as admissible');
    expect(sql).toContain('game.capacity=4');
  });
  it('fails closed on duplicate or malformed reverse mappings', async () => {
    for (const rows of [
      [],
      [row, row],
      [{ ...row, external_id: 'bad id' }],
      [{ ...row, duration_minutes: '0' }],
    ])
      expect(
        await createBookedOperationAdmissionTargetRepository(fixture(rows).pool as never).resolve(
          input,
        ),
      ).toBeNull();
  });
  it('never resolves a CREATE_GAME draft through the JOIN provider mapping', async () => {
    const f = fixture([row], [draftRow]);
    expect(
      await createBookedOperationAdmissionTargetRepository(f.pool as never).resolve({
        ...input,
        action: 'CREATE_GAME',
        actorUserId,
      }),
    ).toBeNull();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('resolves an organizer PROVISIONING draft in bounded tenant scope reading games.games only', async () => {
    const f = fixture([row], [draftRow]);
    expect(
      await createBookedOperationAdmissionTargetRepository(f.pool as never).resolveCreateDraft(
        draftInput,
      ),
    ).toEqual({
      draftGameId: draftRow.id,
      expectedRevision: 1,
      startsAt: '2099-01-01T09:00:00.000Z',
      durationMinutes: 90,
      capacity: 4,
      paymentMode: 'SPLIT',
      admissible: true,
    });
    expect(f.query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      input.tenantId,
    ]);
    expect(f.query).toHaveBeenCalledWith("set local statement_timeout = '1500ms'");
    const [sql, params] = queryFor(f.query, 'from games.games game');
    expect(params).toEqual([input.tenantId, input.targetId, input.expectedRevision, actorUserId]);
    expect(sql).toContain('game.tenant_id=$1');
    expect(sql).toContain('game.id=$2');
    expect(sql).toContain('game.organizer_user_id=$4');
    expect(sql).toContain('game.revision=$3');
    expect(sql).toContain("game.lifecycle_state='PROVISIONING'");
    expect(sql).toContain("game.payment_mode in ('SPLIT','SUBSCRIPTION')");
    expect(sql).toContain('game.capacity=4');
    expect(sql).toContain('game.starts_at>now()');
    expect(sql).toContain('game.cancelled_at is null');
    expect(sql).not.toContain('integration.external_entity_map');
  });
  it('accepts the SPLIT and SUBSCRIPTION draft payment modes', async () => {
    for (const paymentMode of ['SPLIT', 'SUBSCRIPTION'])
      expect(
        await createBookedOperationAdmissionTargetRepository(
          fixture([], [{ ...draftRow, payment_mode: paymentMode }]).pool as never,
        ).resolveCreateDraft(draftInput),
      ).toMatchObject({ paymentMode });
  });
  it('rejects a non-organizer, a foreign tenant and a stale expected revision', async () => {
    const repo = createBookedOperationAdmissionTargetRepository(draftFixture().pool as never);
    expect(await repo.resolveCreateDraft(draftInput)).toMatchObject({
      draftGameId: input.targetId,
    });
    for (const changed of [
      { actorUserId: randomUUID() },
      { tenantId: randomUUID() },
      { expectedRevision: 2 },
    ])
      expect(await repo.resolveCreateDraft({ ...draftInput, ...changed })).toBeNull();
  });
  it('rejects SCHEDULED/PUBLISHED drafts, non-subscription payment modes and cancelled drafts', async () => {
    // Those conditions are part of the SQL predicate, so no eligible row is returned for them.
    const scoped = draftFixture();
    expect(
      await createBookedOperationAdmissionTargetRepository(scoped.pool as never).resolveCreateDraft(
        draftInput,
      ),
    ).not.toBeNull();
    const [sql] = queryFor(scoped.query, 'from games.games game');
    expect(sql).toContain("game.lifecycle_state='PROVISIONING'");
    expect(sql).toContain("game.payment_mode in ('SPLIT','SUBSCRIPTION')");
    expect(sql).toContain('game.cancelled_at is null');
    expect(sql).toContain('game.starts_at>now()');
    // A row that the database would not have selected is still refused when its eligibility is false.
    expect(
      await createBookedOperationAdmissionTargetRepository(
        draftFixture(draftInput, { ...draftRow, admissible: false }).pool as never,
      ).resolveCreateDraft(draftInput),
    ).toBeNull();
  });
  it('fails closed on missing, duplicate or malformed drafts', async () => {
    for (const rows of [
      [], // missing draft
      [draftRow, draftRow],
      [{ ...draftRow, id: 'bad draft id' }],
      [{ ...draftRow, id: draftRow.id.toUpperCase() }],
      [{ ...draftRow, revision: '0' }],
      [{ ...draftRow, revision: 'not-a-revision' }],
      [{ ...draftRow, duration_minutes: '0' }],
      [{ ...draftRow, duration_minutes: 'not-a-number' }],
      [{ ...draftRow, capacity: 3 }],
      [{ ...draftRow, payment_mode: 'ORGANIZER_PAYS' }],
      [{ ...draftRow, starts_at: new Date('invalid') }],
      [{ ...draftRow, admissible: false }],
    ])
      expect(
        await createBookedOperationAdmissionTargetRepository(
          fixture([], rows).pool as never,
        ).resolveCreateDraft(draftInput),
      ).toBeNull();
  });
});

describe('internal CREATE location binding resolver', () => {
  it('checks the authenticated original draft before integration reads', async () => {
    const f = fixture();
    const repository = createBookedOperationAdmissionTargetRepository(f.pool as never);
    expect(await repository.resolveCreateDraftLocation(draftInput)).toBeNull();
    const calls = f.query.mock.calls.map(([sql]) => sql);
    expect(
      calls.some((sql) => sql.includes('organizer_user_id=$3') && sql.includes('for share')),
    ).toBe(true);
    expect(calls.some((sql) => sql.includes('game_create_location_bindings'))).toBe(false);
  });
  it('does not add integration identifiers to the established draft response', async () => {
    const f = fixture([], [draftRow]);
    const result = await createBookedOperationAdmissionTargetRepository(
      f.pool as never,
    ).resolveCreateDraft(draftInput);
    expect(result).not.toHaveProperty('provider_room_id');
    expect(result).not.toHaveProperty('locationBinding');
  });
});
