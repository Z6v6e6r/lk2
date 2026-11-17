import { describe, expect, it, vi } from 'vitest';

import {
  createVivaSubscriptionMappingSync,
  type VivaSubscriptionMappingSyncDependencies,
} from './viva-subscription-mapping-sync.js';

const input = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  correlationId: 'corr-sync',
};
const profile = {
  profileMappingId: '00000000-0000-4000-8000-000000000003',
  providerClientId: '11111111-1111-4111-8111-111111111111',
};
const subscriptionId = '22222222-2222-4222-8222-222222222222';
class OwnershipConflict extends Error {}

function deps(overrides: Partial<VivaSubscriptionMappingSyncDependencies> = {}) {
  return {
    readProfile: vi.fn(() => Promise.resolve(profile)),
    readSubscriptions: vi.fn(() =>
      Promise.resolve({
        providerSubscriptionIds: [subscriptionId],
        observedAt: '2026-11-09T10:00:00.000Z',
      }),
    ),
    record: vi.fn(() => Promise.resolve({ outcome: 'synced' as const, conflicts: 0 })),
    isOwnershipConflict: (error: unknown) => error instanceof OwnershipConflict,
    ...overrides,
  } satisfies VivaSubscriptionMappingSyncDependencies;
}

describe('Viva subscription mapping sync (ADR 0029 D5)', () => {
  it('reads the mapped client only and records the read bound to the same profile', async () => {
    const d = deps();
    await expect(createVivaSubscriptionMappingSync(d)(input)).resolves.toBe('synced');
    expect(d.readProfile).toHaveBeenCalledWith({ tenantId: input.tenantId, userId: input.userId });
    expect(d.readSubscriptions).toHaveBeenCalledWith({
      providerClientId: profile.providerClientId,
      correlationId: input.correlationId,
    });
    expect(d.record).toHaveBeenCalledWith({
      ...input,
      ...profile,
      providerSubscriptionIds: [subscriptionId],
      observedAt: '2026-11-09T10:00:00.000Z',
    });
  });

  it('never calls the provider for a user without a synced profile mapping', async () => {
    const d = deps({ readProfile: vi.fn(() => Promise.resolve(null)) });
    await expect(createVivaSubscriptionMappingSync(d)(input)).resolves.toBe('unmapped');
    expect(d.readSubscriptions).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it('writes nothing when the provider read fails or names another owner', async () => {
    const down = deps({ readSubscriptions: vi.fn(() => Promise.reject(new Error('timeout'))) });
    await expect(createVivaSubscriptionMappingSync(down)(input)).resolves.toBe('unavailable');
    expect(down.record).not.toHaveBeenCalled();

    const foreign = deps({
      readSubscriptions: vi.fn(() => Promise.reject(new OwnershipConflict())),
    });
    await expect(createVivaSubscriptionMappingSync(foreign)(input)).resolves.toBe(
      'ownership_conflict',
    );
    expect(foreign.record).not.toHaveBeenCalled();
  });

  it('reports repository outcomes as labels', async () => {
    const conflicts = deps({
      record: vi.fn(() => Promise.resolve({ outcome: 'synced' as const, conflicts: 2 })),
    });
    await expect(createVivaSubscriptionMappingSync(conflicts)(input)).resolves.toBe(
      'synced_with_conflicts',
    );
    const moved = deps({
      record: vi.fn(() => Promise.resolve({ outcome: 'profile_changed' as const, conflicts: 0 })),
    });
    await expect(createVivaSubscriptionMappingSync(moved)(input)).resolves.toBe('profile_changed');
    const failed = deps({ record: vi.fn(() => Promise.reject(new Error('db down'))) });
    await expect(createVivaSubscriptionMappingSync(failed)(input)).resolves.toBe('unavailable');
    const profileDown = deps({ readProfile: vi.fn(() => Promise.reject(new Error('db down'))) });
    await expect(createVivaSubscriptionMappingSync(profileDown)(input)).resolves.toBe(
      'unavailable',
    );
  });
});
