import { describe, expect, it, vi } from 'vitest';

import { createLevelEligibilityPolicyRepository } from './level-eligibility-policy-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const requestHash = 'a'.repeat(64);
const current = {
  id: '33333333-3333-4333-8333-333333333333',
  sport_code: 'PADEL',
  activity_type: 'GAME',
  mode: 'OFF',
  lower_tolerance_steps: 0,
  upper_tolerance_steps: 0,
  missing_activity_constraint_action: 'ALLOW',
  legacy_text_constraint_action: 'ALLOW',
  recheck_waitlist_promotion: true,
  version: 1,
  change_comment: 'Safe initial policy',
  updated_by: null,
  created_at: '2026-08-16T10:00:00.000Z',
};
const next = {
  ...current,
  id: '44444444-4444-4444-8444-444444444444',
  mode: 'SHADOW',
  lower_tolerance_steps: 1,
  upper_tolerance_steps: 2,
  version: 2,
  change_comment: 'Start shadow',
  updated_by: actorUserId,
  created_at: '2026-08-16T11:00:00.000Z',
};

function input() {
  return {
    tenantId,
    actorUserId,
    sportCode: 'PADEL',
    activityType: 'GAME' as const,
    expectedVersion: 1,
    mode: 'SHADOW' as const,
    lowerToleranceSteps: 1,
    upperToleranceSteps: 2,
    missingActivityConstraintAction: 'WARN' as const,
    legacyTextConstraintAction: 'WARN' as const,
    recheckWaitlistPromotion: true,
    changeComment: 'Start shadow',
    idempotencyKey: 'level-policy-publish-0001',
    requestHash,
  };
}

function pool(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('level eligibility policy repository', () => {
  it('publishes one immutable version and records old/new audit plus idempotency', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback')
        return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.policy_commands')) return Promise.resolve({ rows: [] });
      if (text.includes('count(*)::integer as count'))
        return Promise.resolve({ rows: [{ count: 7 }] });
      if (text.includes('from eligibility.level_policies') && text.includes('for update'))
        return Promise.resolve({ rows: [current] });
      if (text.includes('insert into eligibility.level_policies'))
        return Promise.resolve({ rows: [next] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(
      createLevelEligibilityPolicyRepository(pool(query) as never).publish(input()),
    ).resolves.toMatchObject({
      outcome: 'applied',
      policy: { version: 2, mode: 'SHADOW' },
      replayed: false,
    });
    expect(query.mock.calls.some(([text]) => text.includes('set active = false'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('insert into audit.audit_log'))).toBe(
      true,
    );
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into eligibility.policy_commands')),
    ).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('replays the stored policy only for the same request hash', async () => {
    const stored = {
      id: next.id,
      sportCode: 'PADEL',
      activityType: 'GAME',
      mode: 'SHADOW',
      lowerToleranceSteps: 1,
      upperToleranceSteps: 2,
      missingActivityConstraintAction: 'WARN',
      legacyTextConstraintAction: 'WARN',
      recheckWaitlistPromotion: true,
      version: 2,
      changeComment: 'Start shadow',
      updatedBy: actorUserId,
      createdAt: '2026-08-16T11:00:00.000Z',
    };
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback')
        return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.policy_commands')) {
        return Promise.resolve({ rows: [{ request_hash: requestHash, result_payload: stored }] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createLevelEligibilityPolicyRepository(pool(query) as never).publish(input()),
    ).resolves.toEqual({ outcome: 'applied', policy: stored, replayed: true });
  });

  it('refuses BLOCK until every authoritative activation gate has evidence', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback')
        return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.policy_commands')) return Promise.resolve({ rows: [] });
      if (text.includes('count(*)::integer as count'))
        return Promise.resolve({ rows: [{ count: 7 }] });
      if (text.includes('from eligibility.activation_readiness')) {
        return Promise.resolve({
          rows: [
            {
              writer_authoritative: true,
              player_projection_ready: false,
              client_recovery_ready: false,
              payment_recovery_ready: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createLevelEligibilityPolicyRepository(pool(query) as never).publish({
        ...input(),
        mode: 'BLOCK',
      }),
    ).resolves.toEqual({
      outcome: 'activation_not_ready',
      missingGates: ['player_projection_ready', 'client_recovery_ready'],
    });
  });
});
