import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createParticipationLevelGate } from './participation-level-gate.js';

const connectionString = process.env.PARTICIPATION_LEVEL_GATE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres('participation level gate on PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const gate = createParticipationLevelGate(pool);
  afterAll(async () => pool.end());

  async function tenant(
    mode: 'OFF' | 'SHADOW' | 'WARN' | 'BLOCK',
    tolerance = 0,
    activityType: 'TOURNAMENT' | 'TRAINING' = 'TOURNAMENT',
  ) {
    const tenantId = randomUUID();
    const playerId = randomUUID();
    await pool.query(
      'insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)',
      [tenantId, `level-gate-${tenantId}`, 'Level gate fixture'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        "insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')",
        [tenantId, playerId],
      );
      await client.query(
        `insert into eligibility.canonical_levels
           (tenant_id, sport_code, code, title, rank, sort_order, scale_version)
         select $1, 'PADEL', code, code, rank, rank, 1
           from (values ('D', 1), ('D+', 2), ('C', 3), ('C+', 4), ('B', 5), ('B+', 6), ('A', 7))
                as level(code, rank)
         on conflict do nothing`,
        [tenantId],
      );
      await client.query(
        `insert into eligibility.level_policies
           (tenant_id, sport_code, activity_type, mode, version,
            lower_tolerance_steps, upper_tolerance_steps)
         values ($1, 'PADEL', $2, $3, 3, $4, $4)
         on conflict (tenant_id, sport_code, activity_type) where active
         do update set mode = excluded.mode, version = excluded.version,
                       lower_tolerance_steps = excluded.lower_tolerance_steps,
                       upper_tolerance_steps = excluded.upper_tolerance_steps`,
        [tenantId, activityType, mode, tolerance],
      );
    });
    return { tenantId, playerId };
  }

  async function setLevel(
    tenantId: string,
    playerId: string,
    code: string,
    source: 'CALCULATED' | 'SELF_DECLARED' = 'CALCULATED',
  ) {
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `insert into eligibility.player_sport_levels
           (tenant_id, player_id, sport_code, level_id, source, scale_version)
         select $1, $2, 'PADEL', id, $4, 1
           from eligibility.canonical_levels
          where tenant_id = $1 and sport_code = 'PADEL' and code = $3 and scale_version = 1`,
        [tenantId, playerId, code, source],
      ),
    );
  }

  const decide = (
    t: { tenantId: string; playerId: string },
    levelRange: { from: string; to: string } | null,
    activityType: 'TOURNAMENT' | 'TRAINING' = 'TOURNAMENT',
  ) =>
    gate.decide({
      tenantId: t.tenantId,
      playerId: t.playerId,
      sportCode: 'PADEL',
      activityType,
      activityId: randomUUID(),
      action: activityType === 'TOURNAMENT' ? 'REGISTER' : 'BOOK',
      levelRange,
      constraintSource:
        activityType === 'TOURNAMENT' ? 'LEGACY_TOURNAMENT_SETTINGS' : 'VIVA_EXERCISE',
      correlationId: 'synthetic',
    });

  it('reads the active policy mode per activity type', async () => {
    const t = await tenant('BLOCK', 0, 'TRAINING');
    await expect(gate.mode(t.tenantId, 'PADEL', 'TRAINING')).resolves.toBe('BLOCK');
  });

  it('BLOCK denies an out-of-range CUP level and persists the decision', async () => {
    const t = await tenant('BLOCK');
    await setLevel(t.tenantId, t.playerId, 'D');
    const denied = await decide(t, { from: 'C', to: 'B' });
    expect(denied).toMatchObject({
      allowed: false,
      outcome: 'FAIL',
      reasonCode: 'LEVEL_NOT_ALLOWED',
      mode: 'BLOCK',
      policyVersion: 3,
    });
    const row = await withTenantTransaction(pool, t.tenantId, (client) =>
      client.query<{ status: string; activity_type: string; action: string; details: object }>(
        'select status, activity_type, action, details from eligibility.decisions where tenant_id = $1 and id = $2',
        [t.tenantId, denied.decisionId],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      status: 'DENIED',
      activity_type: 'TOURNAMENT',
      action: 'REGISTER',
    });
    expect(row.rows[0]?.details).toMatchObject({
      playerRank: 1,
      declaredFrom: 'C',
      declaredTo: 'B',
    });
  });

  it('BLOCK allows an in-range CUP level and an unrestricted activity', async () => {
    const t = await tenant('BLOCK', 0, 'TRAINING');
    await setLevel(t.tenantId, t.playerId, 'C+');
    await expect(decide(t, { from: 'C', to: 'B' }, 'TRAINING')).resolves.toMatchObject({
      allowed: true,
      reasonCode: 'LEVEL_ALLOWED',
    });
    await expect(decide(t, null, 'TRAINING')).resolves.toMatchObject({
      allowed: true,
      reasonCode: 'ACTIVITY_HAS_NO_LEVEL_RESTRICTION',
    });
  });

  it('uses a self-declared level when CUP has not projected one', async () => {
    const t = await tenant('BLOCK');
    await setLevel(t.tenantId, t.playerId, 'B', 'SELF_DECLARED');
    await expect(decide(t, { from: 'C', to: 'B' })).resolves.toMatchObject({ allowed: true });
  });

  it('requires a level when the player has none', async () => {
    const t = await tenant('BLOCK');
    await expect(decide(t, { from: 'C', to: 'B' })).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'PLAYER_LEVEL_REQUIRED',
    });
  });

  it('applies the configured policy tolerance', async () => {
    const t = await tenant('BLOCK', 1);
    await setLevel(t.tenantId, t.playerId, 'D+');
    await expect(decide(t, { from: 'C', to: 'B' })).resolves.toMatchObject({ allowed: true });
  });

  it('treats an unknown level code as an invalid constraint', async () => {
    const t = await tenant('BLOCK');
    await setLevel(t.tenantId, t.playerId, 'C');
    await expect(decide(t, { from: 'C', to: 'Z' })).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'ACTIVITY_LEVEL_INVALID',
    });
  });

  it('WARN and SHADOW never deny', async () => {
    for (const mode of ['WARN', 'SHADOW'] as const) {
      const t = await tenant(mode);
      await setLevel(t.tenantId, t.playerId, 'A');
      await expect(decide(t, { from: 'D', to: 'C' })).resolves.toMatchObject({ allowed: true });
    }
  });
});
