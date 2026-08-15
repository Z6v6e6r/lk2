import type { NotificationEndpointCipher, NotificationPushDeliveryPort } from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  WEB_PUSH_DELIVERY_LEASE_SECONDS,
  resolveNotificationIntentState,
  runWebPushDeliveryBatch,
  webPushRetryDelayMs,
} from './web-push-delivery.js';

function result(rows: readonly unknown[] = [], rowCount = rows.length): QueryResult<never> {
  return {
    command: '',
    rowCount,
    oid: 0,
    fields: [],
    rows: [...rows] as never[],
  };
}

describe('Web Push delivery state machine', () => {
  it('keeps the database lease longer than the maximum provider timeout', () => {
    expect(WEB_PUSH_DELIVERY_LEASE_SECONDS).toBeGreaterThan(30);
  });

  it('claims active and terminalizable endpoints while policy-suspended deliveries remain pending', async () => {
    const queries: string[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      queries.push(text);
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve(result());
      }
      if (text.includes('for update of d skip locked')) return Promise.resolve(result());
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool;
    const output = await runWebPushDeliveryBatch({
      pool,
      logger: { info: vi.fn(), error: vi.fn() } as unknown as Logger,
      tenantId: '11111111-1111-4111-8111-111111111111',
      appId: 'padlhub-web',
      environment: 'SANDBOX',
      cipher: {} as NotificationEndpointCipher,
      adapter: {} as NotificationPushDeliveryPort,
      maxAttempts: 5,
      retryBaseMs: 5_000,
    });

    expect(output).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0, stale: 0 });
    expect(queries.find((text) => text.includes('for update of d skip locked'))).toContain(
      "and e.status in ('ACTIVE', 'INVALID', 'REVOKED')",
    );
    expect(queries.find((text) => text.includes('for update of d skip locked'))).not.toContain(
      "'SUSPENDED_POLICY'",
    );
  });

  it('terminalizes a revoked endpoint backlog without decrypting or calling the provider', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const deliveryId = '22222222-2222-4222-8222-222222222222';
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      if (text.includes('for update of d skip locked')) {
        return Promise.resolve(
          result([
            {
              id: deliveryId,
              intent_id: '33333333-3333-4333-8333-333333333333',
              provider_account_id: '44444444-4444-4444-8444-444444444444',
              endpoint_id: '55555555-5555-4555-8555-555555555555',
              endpoint_status: 'REVOKED',
              address_ciphertext: Buffer.from('retained-ciphertext'),
              encryption_key_id: 'v1',
              notification_id: '66666666-6666-4666-8666-666666666666',
              deep_link: null,
              attempt_count: 0,
            },
          ]),
        );
      }
      if (text.includes('select state') && text.includes('notifications.deliveries')) {
        return Promise.resolve(result([{ state: 'DEAD' }]));
      }
      if (text.includes('update notifications.deliveries')) {
        return Promise.resolve(result([], 1));
      }
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve(result());
      }
      return Promise.resolve(result([], 1));
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool;
    const decrypt = vi.fn();
    const send = vi.fn();

    await expect(
      runWebPushDeliveryBatch({
        pool,
        logger: { info: vi.fn(), error: vi.fn() } as unknown as Logger,
        tenantId,
        appId: 'padlhub-web',
        environment: 'SANDBOX',
        cipher: { decrypt } as unknown as NotificationEndpointCipher,
        adapter: { platform: 'WEB', send } as unknown as NotificationPushDeliveryPort,
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toEqual({ claimed: 1, sent: 0, retried: 0, dead: 1, stale: 0 });

    expect(decrypt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const outbox = query.mock.calls.find(([text]) => String(text).includes('audit.outbox_events'));
    expect(outbox?.[1]).toContain(
      JSON.stringify({
        deliveryId,
        state: 'DEAD',
        errorCode: 'WEB_PUSH_ENDPOINT_INACTIVE',
      }),
    );
  });

  it('does not exhaust the last delivery attempt when the provider circuit suppresses the call', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const deliveryId = '22222222-2222-4222-8222-222222222222';
    const queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('for update of d skip locked')) {
        return Promise.resolve(
          result([
            {
              id: deliveryId,
              intent_id: '33333333-3333-4333-8333-333333333333',
              provider_account_id: '44444444-4444-4444-8444-444444444444',
              endpoint_id: '55555555-5555-4555-8555-555555555555',
              endpoint_status: 'ACTIVE',
              address_ciphertext: Buffer.from('ciphertext'),
              encryption_key_id: 'test-key',
              notification_id: '66666666-6666-4666-8666-666666666666',
              deep_link: null,
              attempt_count: 4,
            },
          ]),
        );
      }
      if (text.includes('update notifications.deliveries')) {
        return Promise.resolve(result([], 1));
      }
      return Promise.resolve(result());
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool;
    const subscription = JSON.stringify({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(16) },
    });

    await expect(
      runWebPushDeliveryBatch({
        pool,
        logger: { info: vi.fn(), error: vi.fn() } as unknown as Logger,
        tenantId,
        appId: 'padlhub-web',
        environment: 'SANDBOX',
        cipher: {
          decrypt: vi.fn().mockReturnValue(subscription),
        } as unknown as NotificationEndpointCipher,
        adapter: {
          platform: 'WEB',
          send: vi.fn().mockResolvedValue({
            outcome: 'retryable_failure',
            errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
          }),
        },
        maxAttempts: 5,
        retryBaseMs: 5_000,
        circuitOpenRetryMs: 30_000,
      }),
    ).resolves.toEqual({ claimed: 1, sent: 0, retried: 1, dead: 0, stale: 0 });

    const defer = queries.find((entry) => entry.text.includes('attempt_count = $3 - 1'));
    expect(defer?.values).toEqual([tenantId, deliveryId, 5, 30_000, 'WEB_PUSH_CIRCUIT_OPEN']);
    expect(queries.some((entry) => entry.text.includes('delivery_attempts'))).toBe(false);
    expect(queries.some((entry) => entry.text.includes('outbox_events'))).toBe(false);
  });

  it('uses bounded exponential retry delays', () => {
    expect(webPushRetryDelayMs(1, 5_000)).toBe(5_000);
    expect(webPushRetryDelayMs(3, 5_000)).toBe(20_000);
    expect(webPushRetryDelayMs(20, 5_000)).toBe(3_600_000);
  });

  it('keeps the intent processing until every channel reaches a terminal state', () => {
    expect(resolveNotificationIntentState(['DELIVERED', 'PENDING'])).toEqual({
      state: 'PROCESSING',
      completed: false,
    });
    expect(resolveNotificationIntentState(['DELIVERED', 'DEAD'])).toEqual({
      state: 'PARTIAL',
      completed: true,
    });
    expect(resolveNotificationIntentState(['DEAD'])).toEqual({
      state: 'FAILED',
      completed: true,
    });
  });

  it('terminates a cross-delivery provider-link conflict without leaking or stopping the batch', async () => {
    const externalMessageId = 'opaque-shared-provider-message';
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const providerAccountId = '22222222-2222-4222-8222-222222222222';
    const deliveryIds = [
      '33333333-3333-4333-8333-333333333331',
      '33333333-3333-4333-8333-333333333332',
    ];
    const intentIds = [
      '44444444-4444-4444-8444-444444444441',
      '44444444-4444-4444-8444-444444444442',
    ];
    const states = new Map(deliveryIds.map((deliveryId) => [deliveryId, 'PENDING']));
    const providerLinks: {
      readonly deliveryId: string;
      readonly providerAccountId: string;
      readonly externalMessageId: string;
    }[] = [];
    const queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('for update of d skip locked')) {
        return Promise.resolve(
          result(
            deliveryIds.map((deliveryId, index) => ({
              id: deliveryId,
              intent_id: intentIds[index],
              provider_account_id: providerAccountId,
              endpoint_id: `55555555-5555-4555-8555-55555555555${index}`,
              endpoint_status: 'ACTIVE',
              address_ciphertext: Buffer.from(`ciphertext-${index}`),
              encryption_key_id: 'test-key',
              notification_id: `66666666-6666-4666-8666-66666666666${index}`,
              deep_link: null,
              attempt_count: 0,
            })),
          ),
        );
      }
      if (text.includes("set state = 'SENDING'")) {
        states.set(String(values[1]), 'SENDING');
        return Promise.resolve(result([], 1));
      }
      if (text.includes("set state = 'SENT'")) {
        states.set(String(values[1]), 'SENT');
        return Promise.resolve(result([], 1));
      }
      if (text.includes("set state = 'DEAD'")) {
        states.set(String(values[1]), 'DEAD');
        return Promise.resolve(result([], 1));
      }
      if (text.includes('insert into integration.notification_provider_links')) {
        const deliveryId = String(values[1]);
        const accountId = String(values[2]);
        const messageId = String(values[3]);
        const conflicts = providerLinks.some(
          (link) =>
            link.deliveryId === deliveryId ||
            (link.providerAccountId === accountId && link.externalMessageId === messageId),
        );
        if (conflicts) return Promise.resolve(result([], 0));
        providerLinks.push({
          deliveryId,
          providerAccountId: accountId,
          externalMessageId: messageId,
        });
        return Promise.resolve(result([{ delivery_id: deliveryId }], 1));
      }
      if (text.includes('from integration.notification_provider_links')) {
        const exact = providerLinks.find(
          (link) =>
            link.deliveryId === String(values[1]) &&
            link.providerAccountId === String(values[2]) &&
            link.externalMessageId === String(values[3]),
        );
        return Promise.resolve(result(exact ? [{ delivery_id: exact.deliveryId }] : []));
      }
      if (text.includes('select state') && text.includes('notifications.deliveries')) {
        const intentId = String(values[1]);
        const deliveryId = deliveryIds[intentIds.indexOf(intentId)];
        return Promise.resolve(result([{ state: states.get(deliveryId as string) }]));
      }
      return Promise.resolve(result());
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const subscription = JSON.stringify({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(16) },
    });
    const cipher = {
      activeKeyId: 'test-key',
      encrypt: vi.fn(),
      decrypt: vi.fn().mockReturnValue(subscription),
    } as unknown as NotificationEndpointCipher;
    const send = vi.fn().mockResolvedValue({ outcome: 'accepted', externalMessageId });
    const adapter = {
      platform: 'WEB',
      send,
    } as NotificationPushDeliveryPort;
    const info = vi.fn();
    const error = vi.fn();
    const logger = { info, error } as unknown as Logger;

    await expect(
      runWebPushDeliveryBatch({
        pool,
        logger,
        tenantId,
        appId: 'padlhub-web',
        environment: 'SANDBOX',
        cipher,
        adapter,
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toEqual({ claimed: 2, sent: 1, retried: 0, dead: 1, stale: 0 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(states.get(deliveryIds[0] as string)).toBe('SENT');
    expect(states.get(deliveryIds[1] as string)).toBe('DEAD');
    expect(JSON.stringify(info.mock.calls)).not.toContain(externalMessageId);
    expect(error).not.toHaveBeenCalled();
    for (const entry of queries.filter(
      (candidate) => !candidate.text.includes('integration.notification_provider_links'),
    )) {
      expect(JSON.stringify(entry.values)).not.toContain(externalMessageId);
    }
    const outbox = queries.find(
      (entry) =>
        entry.text.includes('audit.outbox_events') &&
        entry.values.includes(deliveryIds[1] as string),
    );
    expect(outbox?.values).toContain(
      JSON.stringify({
        deliveryId: deliveryIds[1],
        state: 'DEAD',
        errorCode: 'NOTIFICATION_PROVIDER_MESSAGE_LINK_CONFLICT',
      }),
    );
  });
});
