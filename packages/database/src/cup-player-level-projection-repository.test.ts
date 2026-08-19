import { describe, expect, it, vi } from 'vitest';

import {
  createCupPlayerLevelProjectionRepository,
  type ApplyCupPlayerLevelProjectionInput,
} from './cup-player-level-projection-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const playerId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const levelId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';

function pool(query: ReturnType<typeof vi.fn>) {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

function input(
  overrides: Partial<ApplyCupPlayerLevelProjectionInput> = {},
): ApplyCupPlayerLevelProjectionInput {
  return {
    tenantId,
    externalClientId: 'viva-client-42',
    sportCode: 'PADEL',
    levelCode: 'C+',
    numericValue: 3.63,
    sourceRevision: 4,
    sourceEventId: 'rating_evt:00000000-0000-4000-8000-000000000042',
    sourceEventType: 'RATING_MANUALLY_CHANGED',
    formulaVersion: 'padel-rating-grade-v1',
    occurredAt: '2026-08-19T10:00:00.000Z',
    requestHash: 'a'.repeat(64),
    correlationId: 'cup-level-correlation-0001',
    ...overrides,
  };
}

describe('CUP player level projection repository', () => {
  it('resolves the player and canonical level server-side and writes one atomic projection', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.cup_player_level_projections')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from integration.external_entity_map')) {
        return Promise.resolve({ rows: [{ mapping_id: 'mapping-42', player_id: playerId }] });
      }
      if (text.includes('from eligibility.canonical_levels')) {
        return Promise.resolve({
          rows: [{ id: levelId, code: 'C+', title: 'C+', rank: 4, scale_version: 1 }],
        });
      }
      if (text.includes('update profile.user_summaries')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into eligibility.player_sport_levels')) {
        return Promise.resolve({
          rows: [
            {
              player_id: playerId,
              sport_code: 'PADEL',
              level_id: levelId,
              code: 'C+',
              title: 'C+',
              rank: 4,
              source: 'MANUAL',
              numeric_value: '3.63000',
              scale_version: 1,
              updated_at: '2026-08-19T10:00:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(
      createCupPlayerLevelProjectionRepository(pool(query) as never).apply(input()),
    ).resolves.toMatchObject({
      outcome: 'applied',
      replayed: false,
      level: { playerId, code: 'C+', numericValue: 3.63, source: 'MANUAL' },
    });
    expect(
      query.mock.calls.some(([text]) => text.includes("mapping.external_system = 'VIVA'")),
    ).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('insert into audit.audit_log'))).toBe(
      true,
    );
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('insert into eligibility.cup_player_level_projection_events'),
      ),
    ).toBe(true);
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('pg_advisory_xact_lock') &&
          values?.[0] === `player-level:${tenantId}:${playerId}:PADEL`,
      ),
    ).toBe(true);
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('pg_advisory_xact_lock') &&
          values?.[0] === `cup-level-event:${tenantId}:${input().sourceEventId}`,
      ),
    ).toBe(true);
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('pg_advisory_xact_lock') &&
          values?.[0] === `cup-level:${tenantId}:${input().externalClientId}:PADEL`,
      ),
    ).toBe(true);
    const executedStatements = query.mock.calls.map(([text]) => text);
    const eventRead = executedStatements.find((statement) =>
      statement.includes('from eligibility.cup_player_level_projection_events'),
    );
    const canonicalRead = executedStatements.find((statement) =>
      statement.includes('from eligibility.canonical_levels'),
    );
    const currentProjectionRead = executedStatements.find((statement) =>
      statement.includes('from eligibility.cup_player_level_projections'),
    );
    expect(eventRead).toBeDefined();
    expect(eventRead).not.toMatch(/for update/i);
    expect(canonicalRead).toBeDefined();
    expect(canonicalRead).not.toMatch(/for update/i);
    expect(currentProjectionRead).toMatch(/for update/i);
  });

  it('accepts a newer full snapshot when coalescing skipped intermediate revisions', async () => {
    let projectionReads = 0;
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.cup_player_level_projections')) {
        projectionReads += 1;
        return Promise.resolve({
          rows:
            projectionReads === 1
              ? [
                  {
                    source_revision: 2,
                    source_event_id: 'rating_evt:previous',
                    request_hash: 'b'.repeat(64),
                    player_id: playerId,
                    level_id: levelId,
                  },
                ]
              : [],
        });
      }
      if (text.includes('from integration.external_entity_map')) {
        return Promise.resolve({ rows: [{ mapping_id: 'mapping-42', player_id: playerId }] });
      }
      if (text.includes('from eligibility.canonical_levels')) {
        return Promise.resolve({
          rows: [{ id: levelId, code: 'C+', title: 'C+', rank: 4, scale_version: 1 }],
        });
      }
      if (text.includes('update profile.user_summaries')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into eligibility.player_sport_levels')) {
        return Promise.resolve({
          rows: [
            {
              player_id: playerId,
              sport_code: 'PADEL',
              level_id: levelId,
              code: 'C+',
              title: 'C+',
              rank: 4,
              source: 'MANUAL',
              numeric_value: '3.63000',
              scale_version: 1,
              updated_at: '2026-08-19T10:00:00.000Z',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      createCupPlayerLevelProjectionRepository(pool(query) as never).apply(input()),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  it.each([
    ['RATING_INITIAL_IMPORTED', 'MIGRATED'],
    ['RATING_BOOTSTRAPPED_FROM_VIVA', 'VIVA'],
    ['RATING_MANUALLY_CHANGED', 'MANUAL'],
  ] as const)('preserves %s provenance as %s', async (sourceEventType, expectedSource) => {
    let savedSource: unknown;
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from integration.external_entity_map')) {
        return Promise.resolve({ rows: [{ mapping_id: 'mapping-42', player_id: playerId }] });
      }
      if (text.includes('from eligibility.cup_player_level_projections')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from eligibility.canonical_levels')) {
        return Promise.resolve({
          rows: [{ id: levelId, code: 'C+', title: 'C+', rank: 4, scale_version: 1 }],
        });
      }
      if (text.includes('update profile.user_summaries')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into eligibility.player_sport_levels')) {
        savedSource = values[4];
        return Promise.resolve({
          rows: [
            {
              player_id: playerId,
              sport_code: 'PADEL',
              level_id: levelId,
              code: 'C+',
              title: 'C+',
              rank: 4,
              source: expectedSource,
              numeric_value: '3.63000',
              scale_version: 1,
              updated_at: '2026-08-19T10:00:00.000Z',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await createCupPlayerLevelProjectionRepository(pool(query) as never).apply(
      input({ sourceEventType }),
    );
    expect(savedSource).toBe(expectedSource);
  });

  it('does not trust unmapped external client identifiers', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.cup_player_level_projections')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from integration.external_entity_map'))
        return Promise.resolve({ rows: [] });
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createCupPlayerLevelProjectionRepository(pool(query) as never).apply(input()),
    ).resolves.toEqual({ outcome: 'actor_not_mapped' });
  });

  it('rejects a source event already bound to another external actor before profile mutation', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit') return Promise.resolve({ rows: [] });
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from integration.external_entity_map')) {
        return Promise.resolve({ rows: [{ mapping_id: 'mapping-42', player_id: playerId }] });
      }
      if (text.includes('from eligibility.cup_player_level_projections')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from eligibility.cup_player_level_projection_events')) {
        return Promise.resolve({
          rows: [
            {
              player_id: 'another-player-id',
              sport_code: 'PADEL',
              source_revision: 4,
              request_hash: 'a'.repeat(64),
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createCupPlayerLevelProjectionRepository(pool(query) as never).apply(input()),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
    expect(query.mock.calls.some(([text]) => text.includes('update profile.user_summaries'))).toBe(
      false,
    );
  });
});
