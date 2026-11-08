import { describe, expect, it, vi } from 'vitest';
import type { ParticipationLevelGate } from '@phub/database';

import { createExternalLevelCheck } from './external-level-check.js';

const actor = {
  tenantId: '11111111-1111-4111-a111-111111111111',
  userId: '22222222-2222-4222-a222-222222222222',
  correlationId: 'synthetic',
};
const activityId = '33333333-3333-4333-a333-333333333333';

function harness(
  mode: Awaited<ReturnType<ParticipationLevelGate['mode']>>,
  range: Awaited<ReturnType<Parameters<typeof createExternalLevelCheck>[0]['levelRange']>> | Error,
  decision: Partial<Awaited<ReturnType<ParticipationLevelGate['decide']>>> = {},
) {
  const gate = {
    mode: vi.fn<ParticipationLevelGate['mode']>(async () => Promise.resolve(mode)),
    decide: vi.fn<ParticipationLevelGate['decide']>(async () =>
      Promise.resolve({
        decisionId: '44444444-4444-4444-a444-444444444444',
        mode,
        outcome: 'PASS',
        reasonCode: 'LEVEL_ALLOWED',
        allowed: true,
        policyVersion: 2,
        ...decision,
      }),
    ),
  };
  const levelRange = vi.fn(async () =>
    range instanceof Error ? Promise.reject(range) : Promise.resolve(range),
  );
  const check = createExternalLevelCheck({
    gate,
    activityType: 'TRAINING',
    action: 'BOOK',
    constraintSource: 'VIVA_EXERCISE',
    levelRange,
  });
  return { gate, levelRange, check };
}

describe('external participation level check', () => {
  it('OFF policy reads no provider constraint and writes no decision', async () => {
    const h = harness('OFF', { from: 'C', to: 'B' });
    await expect(h.check(actor, activityId, '2035-04-02')).resolves.toBeNull();
    expect(h.levelRange).not.toHaveBeenCalled();
    expect(h.gate.decide).not.toHaveBeenCalled();
  });

  it('BLOCK refuses with the canonical reason code after persisting the decision', async () => {
    const h = harness(
      'BLOCK',
      { from: 'C', to: 'B' },
      { outcome: 'FAIL', reasonCode: 'LEVEL_NOT_ALLOWED', allowed: false },
    );
    await expect(h.check(actor, activityId, '2035-04-02')).resolves.toEqual({
      code: 'LEVEL_NOT_ALLOWED',
      status: 409,
    });
    expect(h.levelRange).toHaveBeenCalledWith(actor, activityId, '2035-04-02');
    expect(h.gate.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: actor.tenantId,
        playerId: actor.userId,
        sportCode: 'PADEL',
        activityType: 'TRAINING',
        activityId,
        action: 'BOOK',
        levelRange: { from: 'C', to: 'B' },
      }),
    );
  });

  it('BLOCK asks for a level when the player has none', async () => {
    const h = harness(
      'BLOCK',
      { from: 'C', to: 'B' },
      { outcome: 'FAIL', reasonCode: 'PLAYER_LEVEL_REQUIRED', allowed: false },
    );
    await expect(h.check(actor, activityId)).resolves.toEqual({
      code: 'PLAYER_LEVEL_REQUIRED',
      status: 409,
    });
  });

  it('allowed and WARN outcomes continue', async () => {
    await expect(
      harness('BLOCK', { from: 'C', to: 'B' }).check(actor, activityId),
    ).resolves.toBeNull();
    await expect(
      harness('WARN', null, { outcome: 'WARN', reasonCode: 'LEVEL_NOT_ALLOWED' }).check(
        actor,
        activityId,
      ),
    ).resolves.toBeNull();
  });

  it('an activity without restriction is evaluated as NONE, not as unknown', async () => {
    const h = harness('BLOCK', null);
    await expect(h.check(actor, activityId)).resolves.toBeNull();
    expect(h.gate.decide).toHaveBeenCalledWith(expect.objectContaining({ levelRange: null }));
  });

  it('unknown constraint fails closed in BLOCK/WARN and continues only in SHADOW', async () => {
    for (const range of [undefined, new Error('VIVA_TIMEOUT')]) {
      const blocked = harness('BLOCK', range);
      await expect(blocked.check(actor, activityId)).resolves.toEqual({
        code: 'PARTICIPATION_LEVEL_UNAVAILABLE',
        status: 503,
      });
      expect(blocked.gate.decide).not.toHaveBeenCalled();
      await expect(harness('WARN', range).check(actor, activityId)).resolves.toMatchObject({
        status: 503,
      });
      await expect(harness('SHADOW', range).check(actor, activityId)).resolves.toBeNull();
    }
  });
});
