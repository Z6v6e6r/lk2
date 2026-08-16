import { describe, expect, it, vi } from 'vitest';

import { createPlayerLevelRepository } from './player-level-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const playerId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const levelId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const levelRow = {
  id: levelId,
  sport_code: 'PADEL',
  code: 'C+',
  title: 'C+',
  rank: 4,
  sort_order: 4,
  aliases: ['C+'],
  active: true,
  scale_version: 1,
};
const savedRow = {
  player_id: playerId,
  sport_code: 'PADEL',
  level_id: levelId,
  code: 'C+',
  title: 'C+',
  rank: 4,
  source: 'SELF_DECLARED',
  numeric_value: null,
  scale_version: 1,
  updated_at: '2026-08-16T18:00:00.000Z',
};

function pool(query: ReturnType<typeof vi.fn>) {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

function input() {
  return {
    tenantId,
    playerId,
    sportCode: 'PADEL',
    levelId,
    source: 'SELF_DECLARED' as const,
    idempotencyKey: 'profile-level-command-0001',
    requestHash: 'a'.repeat(64),
    correlationId: 'profile-level-correlation-0001',
  };
}

describe('player level repository', () => {
  it('returns only the current canonical scale and player projection', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.canonical_levels')) {
        return Promise.resolve({ rows: [levelRow] });
      }
      if (text.includes('from eligibility.player_sport_levels player')) {
        return Promise.resolve({ rows: [savedRow] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createPlayerLevelRepository(pool(query) as never).getState(tenantId, playerId, 'PADEL'),
    ).resolves.toMatchObject({
      scaleVersion: 1,
      levels: [{ id: levelId, code: 'C+', rank: 4 }],
      currentLevel: { levelId, source: 'SELF_DECLARED' },
    });
  });

  it('updates the canonical projection and profile atomically with audit and idempotency', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.player_level_commands')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from eligibility.canonical_levels')) {
        return Promise.resolve({ rows: [levelRow] });
      }
      if (text.includes('from eligibility.player_sport_levels player')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('update profile.user_summaries')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into eligibility.player_sport_levels')) {
        return Promise.resolve({ rows: [savedRow], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      createPlayerLevelRepository(pool(query) as never).setLevel(input()),
    ).resolves.toMatchObject({
      outcome: 'applied',
      replayed: false,
      level: { code: 'C+', source: 'SELF_DECLARED' },
    });
    expect(query.mock.calls.some(([text]) => text.includes('insert into audit.audit_log'))).toBe(
      true,
    );
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('insert into eligibility.player_level_commands'),
      ),
    ).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('does not repeat profile writes for an idempotent replay', async () => {
    const stored = {
      playerId,
      sportCode: 'PADEL',
      levelId,
      code: 'C+',
      title: 'C+',
      rank: 4,
      source: 'SELF_DECLARED',
      numericValue: null,
      scaleVersion: 1,
      updatedAt: '2026-08-16T18:00:00.000Z',
    };
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.player_level_commands')) {
        return Promise.resolve({
          rows: [{ request_hash: input().requestHash, result_payload: stored }],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createPlayerLevelRepository(pool(query) as never).setLevel(input()),
    ).resolves.toEqual({ outcome: 'applied', level: stored, replayed: true });
  });

  it('persists a server-computed onboarding numeric value with its source', async () => {
    const onboardingRow = {
      ...savedRow,
      source: 'ONBOARDING',
      numeric_value: '3.63000',
    };
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.player_level_commands'))
        return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.canonical_levels'))
        return Promise.resolve({ rows: [levelRow] });
      if (text.includes('from eligibility.player_sport_levels player'))
        return Promise.resolve({ rows: [] });
      if (text.includes('update profile.user_summaries')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into eligibility.player_sport_levels')) {
        return Promise.resolve({ rows: [onboardingRow], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(
      createPlayerLevelRepository(pool(query) as never).setLevel({
        ...input(),
        source: 'ONBOARDING',
        numericValue: 3.63,
      }),
    ).resolves.toMatchObject({
      outcome: 'applied',
      level: { source: 'ONBOARDING', numericValue: 3.63 },
    });
    expect(
      query.mock.calls.some(
        ([text]) =>
          text.includes('update profile.user_summaries') && text.includes('level_value = $4'),
      ),
    ).toBe(true);
  });
});
