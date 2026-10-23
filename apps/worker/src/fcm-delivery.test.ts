import type { NotificationEndpointCipher, NotificationPushDeliveryPort } from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { buildFcmData, runFcmDeliveryBatch } from './fcm-delivery.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-4222-8222-222222222222';
function result(rows: readonly unknown[] = [], rowCount = rows.length): QueryResult<never> {
  return { command: '', rowCount, oid: 0, fields: [], rows: [...rows] as never[] };
}
function row(status: 'ACTIVE' | 'REVOKED' = 'ACTIVE', attempts = 0) {
  return {
    id: deliveryId,
    intent_id: '33333333-3333-4333-8333-333333333333',
    provider_account_id: '44444444-4444-4444-8444-444444444444',
    endpoint_id: '55555555-5555-4555-8555-555555555555',
    endpoint_status: status,
    address_ciphertext: Buffer.from('cipher'),
    encryption_key_id: 'v1',
    notification_id: '66666666-6666-4666-8666-666666666666',
    deep_link: '/chats/77777777-7777-4777-8777-777777777777',
    attempt_count: attempts,
  };
}
function fakePool(
  input: ReturnType<typeof row>,
  capture: { text: string; values: readonly unknown[] }[],
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    capture.push({ text, values });
    if (text.includes('for update of d skip locked')) return Promise.resolve(result([input]));
    if (text.includes('select state') && text.includes('notifications.deliveries'))
      return Promise.resolve(result([{ state: 'DEAD' }]));
    if (text.includes('update notifications.deliveries')) return Promise.resolve(result([], 1));
    return Promise.resolve(result([], 1));
  });
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool;
}
const options = (
  pool: Pool,
  cipher: NotificationEndpointCipher,
  adapter: NotificationPushDeliveryPort,
) => ({
  pool,
  logger: { info: vi.fn() } as unknown as Logger,
  tenantId,
  appId: 'ru.padlhub.app',
  environment: 'SANDBOX' as const,
  cipher,
  adapter,
  maxAttempts: 5,
  retryBaseMs: 5_000,
});

describe('FCM delivery state machine', () => {
  it.each([undefined, false, true])(
    'claims only due work with the scenario flag %s',
    async (scenarioPolicyEnabled) => {
      const queries: string[] = [];
      const query = vi.fn((text: string) => {
        queries.push(text);
        return Promise.resolve(result());
      });
      const pool = {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as unknown as Pool;
      await runFcmDeliveryBatch({
        pool,
        logger: { info: vi.fn() } as unknown as Logger,
        tenantId: '11111111-1111-4111-8111-111111111111',
        appId: 'ru.padlhub.app',
        environment: 'SANDBOX',
        cipher: {} as NotificationEndpointCipher,
        adapter: {} as NotificationPushDeliveryPort,
        maxAttempts: 5,
        retryBaseMs: 5000,
        ...(scenarioPolicyEnabled === undefined ? {} : { scenarioPolicyEnabled }),
      });
      const claim = queries.find((sql) => sql.includes('for update of d skip locked'));
      if (scenarioPolicyEnabled) {
        expect(claim).toContain('scenario_run.intent_id=d.intent_id');
        expect(claim).toContain(
          'coalesce(d.scenario_v2_available_at,d.scenario_available_at,d.next_attempt_at)',
        );
        expect(claim).toContain("d.next_attempt_at='infinity'::timestamptz");
      } else expect(claim).not.toContain('scenario_available_at');
    },
  );
  it('keeps payload opaque and terminalizes a revoked endpoint without decrypting or sending', async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const decrypt = vi.fn();
    const send = vi.fn();
    await expect(
      runFcmDeliveryBatch(
        options(
          fakePool(row('REVOKED'), queries),
          { decrypt } as unknown as NotificationEndpointCipher,
          { platform: 'ANDROID', send } as unknown as NotificationPushDeliveryPort,
        ),
      ),
    ).resolves.toEqual({ claimed: 1, sent: 0, retried: 0, dead: 1, stale: 0 });
    expect(decrypt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      queries.find((entry) => entry.text.includes('for update of d skip locked'))?.text,
    ).toContain("a.platform='ANDROID' and a.provider='FCM'");
    expect(
      buildFcmData({
        endpointId: 'endpoint',
        deliveryId: 'delivery',
        notificationId: 'notification',
        deepLink: '/chats/id',
      }),
    ).toEqual({
      endpointId: 'endpoint',
      deliveryId: 'delivery',
      notificationId: 'notification',
      deepLink: '/notifications',
    });
  });

  it('defers an open FCM circuit without burning the attempt or calling finalization', async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const send = vi.fn().mockResolvedValue({
      outcome: 'retryable_failure',
      errorCode: 'FCM_CIRCUIT_OPEN',
      retryAfterMs: 12_000,
    });
    await expect(
      runFcmDeliveryBatch(
        options(
          fakePool(row('ACTIVE', 4), queries),
          {
            decrypt: vi.fn().mockReturnValue('fcm-token'),
          } as unknown as NotificationEndpointCipher,
          { platform: 'ANDROID', send } as unknown as NotificationPushDeliveryPort,
        ),
      ),
    ).resolves.toEqual({ claimed: 1, sent: 0, retried: 1, dead: 0, stale: 0 });
    expect(send).toHaveBeenCalledOnce();
    const defer = queries.find((entry) => entry.text.includes('attempt_count = $3 - 1'));
    expect(defer?.values).toEqual([tenantId, deliveryId, 5, 12_000, 'FCM_CIRCUIT_OPEN']);
    expect(queries.some((entry) => entry.text.includes('delivery_attempts'))).toBe(false);
  });
});
