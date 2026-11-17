import { describe, expect, it, vi } from 'vitest';

import { createProfileProviderObservationRepository } from './profile-provider-observation-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const observedAt = '2026-11-09T06:00:00.000Z';

function repositoryWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve(handler(text, values));
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const pool = { connect };
  return { repository: createProfileProviderObservationRepository(pool as never), query, connect };
}

describe('profile provider observation repository', () => {
  it('reads the tenant-scoped observation and normalizes driver values', async () => {
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('from profile.provider_observations')) {
        return {
          rows: [
            {
              level_label: 'C+',
              level_value: '3.80000',
              balance_minor: '54000',
              currency: 'RUB',
              observed_at: new Date(observedAt),
            },
          ],
        };
      }
      throw new Error('Unexpected query: ' + text);
    });

    await expect(repository.get(tenantId, userId)).resolves.toEqual({
      level: { label: 'C+', value: 3.8 },
      balanceMinor: 54_000,
      currency: 'RUB',
      observedAt,
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('where tenant_id = $1'), [
      tenantId,
      userId,
    ]);
  });

  it('answers undefined when the user has no observation yet', async () => {
    const { repository } = repositoryWithQueries(() => ({ rows: [] }));
    await expect(repository.get(tenantId, userId)).resolves.toBeUndefined();
  });

  it('never publishes a corrupt half-level from the stored row', async () => {
    const { repository } = repositoryWithQueries(() => ({
      rows: [
        {
          level_label: 'ZZ',
          level_value: '3.8',
          balance_minor: null,
          currency: 'RUB',
          observed_at: observedAt,
        },
      ],
    }));
    await expect(repository.get(tenantId, userId)).resolves.toEqual({
      currency: 'RUB',
      observedAt,
    });
  });

  it('upserts an observation only when it is newer than the stored one', async () => {
    const { repository, query } = repositoryWithQueries((text, values) => {
      expect(text).toContain('insert into profile.provider_observations');
      expect(text).toContain('on conflict (tenant_id, user_id) do update');
      expect(text).toContain(
        'where profile.provider_observations.observed_at < excluded.observed_at',
      );
      expect(values).toEqual([tenantId, userId, 'C', 3, 12_500, 'RUB', observedAt]);
      return { rows: [{ observed_at: observedAt }] };
    });

    await expect(
      repository.put({
        tenantId,
        userId,
        observation: {
          level: { label: 'C', value: 3 },
          balanceMinor: 12_500,
          currency: 'RUB',
          observedAt,
        },
      }),
    ).resolves.toBe('accepted');
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('reports an older observation as ignored instead of overwriting the stored one', async () => {
    const { repository } = repositoryWithQueries(() => ({ rows: [] }));
    await expect(
      repository.put({
        tenantId,
        userId,
        observation: { currency: 'RUB', observedAt },
      }),
    ).resolves.toBe('ignored');
  });

  it('persists an absent level and balance as null rather than as fabricated values', async () => {
    const { repository, query } = repositoryWithQueries((_text, values) => {
      expect(values).toEqual([tenantId, userId, null, null, null, 'RUB', observedAt]);
      return { rows: [{ observed_at: observedAt }] };
    });
    await expect(
      repository.put({ tenantId, userId, observation: { currency: 'RUB', observedAt } }),
    ).resolves.toBe('accepted');
    expect(query).toHaveBeenCalled();
  });

  it('rejects an observation that the database constraints would refuse', () => {
    const { repository, connect } = repositoryWithQueries(() => ({ rows: [] }));
    expect(() =>
      repository.put({
        tenantId,
        userId,
        observation: {
          level: { label: 'Z', value: 3 },
          currency: 'RUB',
          observedAt,
        },
      }),
    ).toThrow('PROFILE_PROVIDER_OBSERVATION_INVALID');
    expect(() =>
      repository.put({
        tenantId,
        userId,
        observation: { balanceMinor: 1.5, currency: 'RUB', observedAt },
      }),
    ).toThrow('PROFILE_PROVIDER_OBSERVATION_INVALID');
    expect(() =>
      repository.put({
        tenantId,
        userId,
        observation: { currency: 'RUB', observedAt: 'not-a-date' },
      }),
    ).toThrow('PROFILE_PROVIDER_OBSERVATION_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });
});
