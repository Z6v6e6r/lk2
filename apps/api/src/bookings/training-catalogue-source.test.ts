import { describe, it, expect, vi } from 'vitest';
import { createTrainingCatalogueSource } from './training-catalogue-source.js';
const actor = {
  tenantId: 'tenant',
  tenantKey: 'public-tenant',
  userId: 'actor',
  sessionId: 'session',
  correlationId: 'correlation',
};
describe('server training catalogue access budget', () => {
  it('uses only authoritative provider tenant and reports failed dates separately', async () => {
    const readCompleteTrainingDate = vi.fn(({ date }: { date: string }) => {
      if (date.endsWith('03')) return Promise.reject(new Error('private provider detail'));
      return Promise.resolve([]);
    });
    const adapter = vi.fn(() => ({ readCompleteTrainingDate }));
    const access = vi.fn(() =>
      Promise.resolve({
        accessToken: 'private-credential',
        providerTenantKey: 'authoritative-tenant',
      }),
    );
    const result = await createTrainingCatalogueSource({ access, adapter }).read({
      ...actor,
      dates: ['2035-04-02', '2035-04-03'],
    });
    expect(adapter).toHaveBeenCalledExactlyOnceWith('authoritative-tenant');
    expect(result).toEqual({ activities: [], completedDates: ['2035-04-02'] });
    expect(readCompleteTrainingDate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/private-|authoritative/);
  });
  it('does not access provider after missing delegation or expired access budget', async () => {
    const adapter = vi.fn();
    const missing = createTrainingCatalogueSource({
      adapter,
      access: () => Promise.reject(new Error('reauth')),
    });
    await expect(missing.read({ ...actor, dates: ['2035-04-02'] })).rejects.toThrow();
    let resolveAccess!: (value: { accessToken: string; providerTenantKey: string }) => void;
    const source = createTrainingCatalogueSource({
      adapter,
      budgetMs: 5,
      access: () =>
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
    });
    const result = source.read({ ...actor, dates: ['2035-04-02'] });
    const rejection = expect(result).rejects.toThrow('TRAINING_CATALOGUE_UNAVAILABLE');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await rejection;
    resolveAccess({ accessToken: 'late', providerTenantKey: 'tenant' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter).not.toHaveBeenCalled();
  });
});
