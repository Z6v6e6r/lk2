import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBookedOperationAdmissionTargetRepository } from './booked-operation-admission-target-repository.js';
const input = { tenantId: randomUUID(), targetId: randomUUID(), expectedRevision: 1 };
const row = {
  id: randomUUID(),
  external_id: 'synthetic-exercise',
  external_version: 'fixture-v1',
  starts_at: new Date('2099-01-01T09:00:00.000Z'),
  duration_minutes: '60',
  capacity: 4,
  admissible: true,
};
function fixture(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('select mapping.id') ? rows : [],
  }));
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { query, pool };
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
    const sql = f.query.mock.calls.find(([sql]) => sql.includes('select mapping.id'))?.[0];
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
});
