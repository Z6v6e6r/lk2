import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { checkOrdinaryPushPolicy } from './ordinary-push-policy.js';
import { ordinaryPolicyRow } from './ordinary-push-policy.test-helper.js';
import { runFcmDeliveryBatch } from './fcm-delivery.js';
import { runWebPushDeliveryBatch } from './web-push-delivery.js';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  intentId: '33333333-3333-4333-8333-333333333333',
  providerAccountId: '44444444-4444-4444-8444-444444444444',
  endpointId: '55555555-5555-4555-8555-555555555555',
  attemptNo: 1,
};
function harness(
  provider: 'FCM' | 'WEB_PUSH',
  changes: Record<string, unknown> = {},
  missing = '',
  busyAt = 0,
) {
  const current = ordinaryPolicyRow(provider, changes);
  const queries: { sql: string; values: unknown[] }[] = [];
  let advisories = 0;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    await Promise.resolve();
    queries.push({ sql, values });
    if (missing && sql.includes(missing)) return { rows: [], rowCount: 0 };
    if (sql.includes('pg_try_advisory'))
      return { rows: [{ acquired: ++advisories !== busyAt }], rowCount: 1 };
    if (sql.includes('live_lease')) return { rows: [current], rowCount: 1 };
    if (sql.includes('for update of d skip locked'))
      return {
        rows: [
          {
            id: job.deliveryId,
            intent_id: job.intentId,
            endpoint_id: job.endpointId,
            provider_account_id: job.providerAccountId,
            endpoint_status: 'ACTIVE',
            address_ciphertext: Buffer.from('old-claim'),
            encryption_key_id: 'old-key',
            attempt_count: 0,
            notification_id: job.intentId,
            rendered_title: 'Synthetic',
            rendered_body: 'Synthetic',
            category: 'MESSAGING',
            deep_link: null,
          },
        ],
        rowCount: 1,
      };
    if (sql.startsWith('select state')) return { rows: [{ state: 'SUPPRESSED' }], rowCount: 1 };
    if (sql.includes("render_data->>'scenarioRunId' run_id"))
      return { rows: [{ run_id: current.scenario_run_id }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const pool = { connect: () => Promise.resolve({ query, release: vi.fn() }) } as unknown as Pool;
  const decrypt = vi.fn(() =>
    provider === 'FCM'
      ? 'synthetic-current-token'
      : JSON.stringify({
          endpoint: 'https://push.example.test/synthetic',
          keys: { p256dh: 'a'.repeat(40), auth: 'b'.repeat(16) },
        }),
  );
  const send = vi.fn(() =>
    Promise.resolve({
      outcome: 'terminal_failure' as const,
      errorCode: 'SYNTHETIC_INVALID',
      invalidate: true,
    }),
  );
  const opts = {
    pool,
    logger: { info: vi.fn() } as unknown as Logger,
    tenantId: job.tenantId,
    appId: provider === 'FCM' ? 'ru.padlhub.app' : 'padlhub-web',
    environment: 'SANDBOX' as const,
    cipher: { activeKeyId: 'test', encrypt: vi.fn(), decrypt },
    maxAttempts: 3,
    retryBaseMs: 1000,
  };
  return {
    current,
    queries,
    query,
    pool,
    decrypt,
    send,
    run: (scenarioPolicyEnabled?: boolean) =>
      provider === 'FCM'
        ? runFcmDeliveryBatch({
            ...opts,
            adapter: { platform: 'ANDROID', send },
            ...(scenarioPolicyEnabled === undefined ? {} : { scenarioPolicyEnabled }),
          })
        : runWebPushDeliveryBatch({
            ...opts,
            adapter: { platform: 'WEB', send },
            ...(scenarioPolicyEnabled === undefined ? {} : { scenarioPolicyEnabled }),
          }),
    check: () =>
      checkOrdinaryPushPolicy({
        pool,
        job,
        provider,
        appId: provider === 'FCM' ? 'ru.padlhub.app' : 'padlhub-web',
        environment: 'SANDBOX',
      }),
  };
}

describe.each(['FCM', 'WEB_PUSH'] as const)('ordinary %s current dispatch policy', (provider) => {
  it.each([
    ['owner transfer', { endpoint_user_id: 'foreign' }],
    ['revocation', { endpoint_status: 'REVOKED' }],
    ['user disabled', { user_status: 'DELETED' }],
    ['provider disabled', { provider_status: 'DISABLED' }],
    ['provider transfer', { provider_account_id: 'other' }],
    ['wrong platform', { platform: 'IOS' }],
    ['wrong channel', { endpoint_channel: 'EMAIL' }],
    ['wrong provider channel', { provider_channel: 'EMAIL' }],
    ['wrong provider', { provider: 'APNS' }],
    ['wrong app', { app_id: 'foreign' }],
    ['wrong environment', { environment: 'PRODUCTION' }],
    ['runtime off', { runtime_enabled: false }],
    ['runtime missing', { runtime_enabled: null }],
    ['rule off', { rule_active: false }],
    ['present rule missing', { rule_active: null }],
    ['template off', { template_active: false }],
    ['template missing', { template_active: null }],
    ['ordinary missing rule', { trigger_rule_id: null }],
    ['opt out', { preference_enabled: false }],
    ['DB-clock quiet', { quiet_from: '20:00', quiet_until: '21:00', timezone: 'UTC' }],
  ])('suppresses %s before decrypt/send, without a provider attempt', async (_name, patch) => {
    const h = harness(provider, patch);
    // Direct policy checks use fixed expected app; transport fixtures retain it too.
    expect(await h.run()).toMatchObject({ dead: 1, sent: 0 });
    expect(h.queries.some((x) => x.sql.includes('attempt_count=attempt_count-1'))).toBe(true);
    const lock = h.queries.findIndex((x) =>
      x.sql.startsWith('select id from notifications.intents'),
    );
    const siblings = h.queries.findIndex((x) => x.sql.startsWith('select state'));
    expect(lock).toBeGreaterThan(-1);
    expect(siblings).toBeGreaterThan(lock);
    expect(h.queries.filter((x) => x.sql.includes('insert into audit.outbox_events'))).toHaveLength(
      1,
    );
    expect(h.queries.some((x) => /delivery_attempts|delivery_receipts/u.test(x.sql))).toBe(false);
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    'select id from notifications.deliveries',
    'select id from integration.notification_endpoints',
  ])('refuses lost exact row %s', async (missing) => {
    const h = harness(provider, {}, missing);
    expect(await h.check()).toEqual({ outcome: 'STALE' });
    expect(h.queries.some((x) => x.sql.startsWith('update'))).toBe(false);
  });
  it('checks current lease after row waits and policy uses DB clock', async () => {
    const h = harness(provider, { live_lease: false });
    expect(await h.run()).toMatchObject({ stale: 1 });
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    const policy = h.queries.findIndex((x) => x.sql.includes('live_lease'));
    expect(policy).toBeGreaterThan(
      h.queries.findIndex((x) =>
        x.sql.startsWith('select id from integration.notification_endpoints'),
      ),
    );
    expect(h.queries[policy]!.sql).toContain('clock_timestamp()');
    expect(
      h.queries.find((x) => x.sql.startsWith('select id from notifications.deliveries'))!.values,
    ).toEqual([job.tenantId, job.deliveryId, job.intentId, job.endpointId, job.attemptNo]);
  });
  it('decrypts only fresh address and fences late invalidation with exact dispatched snapshot', async () => {
    const h = harness(provider);
    expect(await h.run()).toMatchObject({ dead: 1 });
    expect(h.decrypt).toHaveBeenCalledExactlyOnceWith(Buffer.from('fresh-cipher'), 'fresh-key');
    expect(h.send).toHaveBeenCalledOnce();
    const invalidation = h.queries.find((x) =>
      x.sql.includes('update integration.notification_endpoints'),
    )!;
    expect(invalidation.values.slice(3)).toEqual([
      Buffer.from('fresh-cipher'),
      'fresh-key',
      h.current.recipient_user_id,
      job.providerAccountId,
    ]);
    expect(invalidation.sql).toContain('provider_account_id = $7');
  });
  it.each([undefined, false, true])(
    'ordinary remains usable with scenario flag %s',
    async (flag) => {
      const h = harness(provider);
      await h.run(flag);
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.queries.some((x) => x.sql.includes("render_data->>'scenarioRunId' run_id"))).toBe(
        false,
      );
    },
  );
  it.each([undefined, false])(
    'retained scenario never enters ordinary when flag=%s',
    async (flag) => {
      const h = harness(provider, { scenario_marked: true, scenario_run_id: 'retained-run' });
      expect(await h.run(flag)).toMatchObject({ stale: 1 });
      expect(h.send).not.toHaveBeenCalled();
    },
  );
  it('malformed scenario scheduling marker cannot become ordinary', async () => {
    const h = harness(provider, { scenario_marked: true, scenario_run_id: null });
    expect(await h.run(true)).toMatchObject({ stale: 1 });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('enabled scenario delegates to existing scenario owner, never ordinary opt-out suppression', async () => {
    const h = harness(provider, {
      scenario_marked: true,
      scenario_run_id: 'retained-run',
      preference_enabled: false,
    });
    expect(await h.check()).toEqual({ outcome: 'SCENARIO' });
    expect(h.queries.some((x) => x.sql.startsWith('update'))).toBe(false);
  });
  it('allows null-rule ADMIN_MESSAGE only as nonmandatory', async () => {
    const yes = harness(provider, {
      trigger_rule_id: null,
      rule_active: null,
      mandatory: null,
      category: 'ADMIN_MESSAGE',
    });
    expect((await yes.check()).outcome).toBe('SEND');
    const no = harness(provider, {
      trigger_rule_id: null,
      mandatory: true,
      category: 'ADMIN_MESSAGE',
      preference_enabled: false,
    });
    expect((await no.check()).outcome).toBe('SUPPRESSED');
  });
  it('current active mandatory rule bypasses quiet/opt-out, never runtime/template fences', async () => {
    const patch = {
      mandatory: true,
      preference_enabled: false,
      quiet_from: '20:00',
      quiet_until: '21:00',
      timezone: 'UTC',
    };
    expect((await harness(provider, patch).check()).outcome).toBe('SEND');
    expect((await harness(provider, { ...patch, template_active: false }).check()).outcome).toBe(
      'SUPPRESSED',
    );
  });
});

describe('FCM pre-dispatch gate contention', () => {
  it.each([3, 4])(
    'gate acquisition %s is before row locks and preserves an unconsumed attempt',
    async (busyAt) => {
      const h = harness('FCM', {}, '', busyAt);
      expect(await h.run()).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.decrypt).not.toHaveBeenCalled();
      expect(
        h.queries.some((x) => x.sql.startsWith('select id from notifications.deliveries')),
      ).toBe(false);
      const defer = h.queries.find((x) => x.sql.includes('attempt_count = $3 - 1'))!;
      expect(defer.values).toEqual([
        job.tenantId,
        job.deliveryId,
        1,
        30000,
        'FCM_ROLLOUT_GATE_BUSY',
        job.intentId,
        job.endpointId,
      ]);
      expect(
        h.queries.filter((x) => x.sql.includes('pg_try_advisory')).map((x) => x.values[0]),
      ).toEqual([
        `notification-runtime:${job.tenantId}`,
        `android-push-provider:${job.tenantId}:ru.padlhub.app:SANDBOX`,
        `notification-runtime:${job.tenantId}`,
        ...(busyAt === 4 ? [`android-push-provider:${job.tenantId}:ru.padlhub.app:SANDBOX`] : []),
      ]);
    },
  );
});
