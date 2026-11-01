import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { checkOrdinaryPushPolicy } from './ordinary-push-policy.js';
import { ordinaryPolicyRow } from './ordinary-push-policy.test-helper.js';
const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  intentId: '33333333-3333-4333-8333-333333333333',
  providerAccountId: '44444444-4444-4444-8444-444444444444',
  endpointId: '55555555-5555-4555-8555-555555555555',
  attemptNo: 1,
  station: { contextId: '66666666-6666-4666-8666-666666666666', generation: 7 },
};
function policy(changes: Record<string, unknown> = {}) {
  const statements: string[] = [];
  const query = vi.fn((sql: string) => {
    statements.push(sql);
    return Promise.resolve({
      rowCount: 1,
      rows: sql.includes('pg_try_advisory')
        ? [{ acquired: true }]
        : sql.includes('live_lease')
          ? [ordinaryPolicyRow('FCM', changes)]
          : sql.includes('select state')
            ? [{ state: 'SUPPRESSED' }]
            : [{ id: job.deliveryId }],
    });
  });
  const pool = { connect: () => Promise.resolve({ query, release: vi.fn() }) } as unknown as Pool;
  return {
    statements,
    options: {
      pool,
      job,
      provider: 'FCM' as const,
      appId: 'ru.padlhub.app',
      environment: 'SANDBOX' as const,
      stationFresh: () => true,
      stationValidate: () => Promise.resolve(),
    },
  };
}
describe('station fresh policy marker boundary', () => {
  it('requires exact generation and acknowledges marker before returning current address', async () => {
    const h = policy();
    expect(await checkOrdinaryPushPolicy(h.options)).toMatchObject({
      outcome: 'SEND',
      endpoint: { encryptionKeyId: 'fresh-key' },
    });
    expect(h.statements.find((x) => x.includes('for update'))).toContain(
      'station_claim_generation=$7',
    );
    const marker = h.statements.findIndex((x) => x.includes('set station_dispatch_started_at'));
    expect(marker).toBeGreaterThan(h.statements.findIndex((x) => x.includes('live_lease')));
    expect(h.statements.at(-1)).toBe('commit');
  });
  it.each([
    { mandatory: true },
    { trigger_rule_id: null, category: 'ADMIN_MESSAGE' },
    { endpoint_user_id: 'other' },
    { rule_active: false },
    { runtime_enabled: false },
    { preference_enabled: false },
  ])('suppresses invalid current station policy %j', async (changes) => {
    const h = policy(changes);
    expect((await checkOrdinaryPushPolicy(h.options)).outcome).toBe('SUPPRESSED');
    expect(h.statements.some((x) => x.includes('set station_dispatch_started_at'))).toBe(false);
  });
  it('rechecks DB policy and clock only after the station identity lock wait', async () => {
    const h = policy();
    const result = await checkOrdinaryPushPolicy({
      ...h.options,
      stationValidate: () => {
        h.statements.push('station identity lock acquired');
        return Promise.resolve();
      },
    });
    expect(result.outcome).toBe('SEND');
    expect(h.statements.findIndex((x) => x.includes('live_lease'))).toBeGreaterThan(
      h.statements.indexOf('station identity lock acquired'),
    );
  });
  it('expired owner budget after waits cannot mint dispatch marker', async () => {
    const h = policy();
    expect(
      (await checkOrdinaryPushPolicy({ ...h.options, stationFresh: () => false })).outcome,
    ).toBe('STALE');
    expect(h.statements.some((x) => x.includes('set station_dispatch_started_at'))).toBe(false);
  });
  it('mapping changed after owner read fails closed before marker', async () => {
    const h = policy();
    await expect(
      checkOrdinaryPushPolicy({
        ...h.options,
        stationValidate: () => Promise.reject(Error('STATION_MAPPING_CHANGED')),
      }),
    ).rejects.toThrow();
    expect(h.statements.at(-1)).toBe('rollback');
    expect(h.statements.some((x) => x.includes('set station_dispatch_started_at'))).toBe(false);
  });
});
