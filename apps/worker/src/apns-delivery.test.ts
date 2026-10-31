import { readFileSync } from 'node:fs';
import type {
  NotificationEndpointCipher,
  NotificationPushDeliveryPort,
  PushDeliveryResult,
} from '@phub/notifications';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { runApnsDeliveryBatch } from './apns-delivery.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const claimRow = {
  id: '22222222-2222-4222-8222-222222222222',
  intent_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  provider_account_id: '55555555-5555-4555-8555-555555555555',
  attempt_count: 0,
};
const recipient = '66666666-6666-4666-8666-666666666666';
const dispatchRow = {
  provider_account_id: claimRow.provider_account_id,
  recipient_user_id: recipient,
  endpoint_user_id: recipient,
  endpoint_status: 'ACTIVE',
  endpoint_channel: 'PUSH',
  address_ciphertext: Buffer.from('synthetic encrypted token'),
  encryption_key_id: 'test-key',
  provider: 'APNS',
  platform: 'IOS',
  provider_channel: 'PUSH',
  app_id: 'ru.padlhub.test',
  environment: 'SANDBOX',
  credential_ref: 'apns-test',
  provider_status: 'ACTIVE',
  user_status: 'ACTIVE',
  ios_push_enabled: true,
  rule_active: true,
  template_active: true,
  mandatory: false,
  preference_enabled: true,
  quiet_from: null as string | null,
  quiet_until: null as string | null,
  timezone: 'UTC',
  database_now: new Date('2026-10-31T12:00:00Z'),
};

/** Query/transition model, not a physical PostgreSQL concurrency test. */
function harness(initial: Partial<typeof dispatchRow> = {}) {
  const endpoint = { ...dispatchRow, ...initial };
  const state = {
    delivery: 'PENDING',
    attempts: 0,
    dispatched: false,
    expired: false,
    crashed: false,
  };
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const records: string[] = [];
  let onClaim: (() => void) | undefined;
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    const result = (rows: unknown[] = [], rowCount = rows.length) =>
      Promise.resolve({ rows, rowCount });
    if (state.crashed) throw new Error('synthetic process connection lost');
    if (text.includes('order by d.lease_expires_at')) {
      expect(text).toContain('for update of d skip locked limit 20');
      return result(
        state.delivery === 'SENDING' && state.dispatched && state.expired
          ? [{ ...claimRow, attempt_count: state.attempts }]
          : [],
      );
    }
    if (text.includes('order by d.next_attempt_at')) {
      expect(text).toContain('for update of d skip locked limit 1');
      expect(text).toContain(
        'd.scenario_available_at is null and d.scenario_v2_available_at is null',
      );
      expect(text).toContain('d.scenario_dispatch_started_at is null');
      expect(values).toEqual([tenantId, 'ru.padlhub.test', 'SANDBOX', 'apns-test']);
      return result(
        !state.dispatched &&
          (state.delivery === 'PENDING' || (state.delivery === 'SENDING' && state.expired))
          ? [{ ...claimRow, attempt_count: state.attempts }]
          : [],
      );
    }
    if (text.includes("set state='SENDING',attempt_count=attempt_count+1")) {
      state.delivery = 'SENDING';
      state.attempts++;
      state.expired = false;
      onClaim?.();
      return result([], 1);
    }
    if (text.includes('clock_timestamp() database_now')) {
      expect(text).toContain('for update of d,e');
      expect(text).toContain('d.attempt_count=$3');
      expect(text).toContain('d.lease_expires_at>clock_timestamp()');
      return result(
        state.delivery === 'SENDING' && !state.expired && !state.dispatched ? [endpoint] : [],
      );
    }
    if (text.includes('set scenario_dispatch_started_at=clock_timestamp()')) {
      expect(text).toContain('lease_expires_at>clock_timestamp()');
      if (state.expired || state.dispatched) return result();
      state.dispatched = true;
      records.push('fence');
      return result([], 1);
    }
    if (text.includes("set state='SUPPRESSED'")) {
      state.delivery = 'SUPPRESSED';
      state.attempts--;
      return result([], 1);
    }
    if (text.includes("set state='DEAD'")) {
      state.delivery = 'DEAD';
      return result([], 1);
    }
    if (text.includes('update notifications.deliveries')) {
      if (state.delivery !== 'SENDING' || values[2] !== state.attempts || state.expired)
        return result();
      if (text.includes("set state = 'SENT'")) state.delivery = 'SENT';
      if (text.includes("set state = 'DEAD'")) state.delivery = 'DEAD';
      if (text.includes("set state = 'PENDING'")) {
        state.delivery = 'PENDING';
        state.dispatched = false;
        if (text.includes('attempt_count = $3 - 1')) state.attempts--;
      }
      return result([], 1);
    }
    if (text.includes('update integration.notification_endpoints')) {
      expect(text).toContain(
        'address_ciphertext = $4 and encryption_key_id = $5 and user_id = $6 and provider_account_id = $7',
      );
      if (
        endpoint.address_ciphertext.equals(values[3] as Buffer) &&
        endpoint.encryption_key_id === values[4] &&
        endpoint.endpoint_user_id === values[5] &&
        endpoint.provider_account_id === values[6]
      ) {
        endpoint.endpoint_status = 'INVALID';
        return result([], 1);
      }
      return result();
    }
    if (text.includes('insert into integration.notification_provider_links'))
      return result([{ delivery_id: claimRow.id }]);
    if (text.includes('select state')) return result([{ state: state.delivery }]);
    if (text.includes('delivery_attempts')) records.push('attempt');
    if (text.includes('outbox_events')) records.push('outbox');
    if (text === 'commit') records.push('commit');
    return result();
  });
  const pool = {
    connect: vi.fn(() => Promise.resolve({ query, release: vi.fn() })),
  } as unknown as Pool;
  const decrypt = vi.fn(() => 'ab'.repeat(32));
  const send = vi.fn((): Promise<PushDeliveryResult> => {
    expect(records.at(-1)).toBe('commit');
    expect(state.dispatched).toBe(true);
    return Promise.resolve({ outcome: 'accepted', externalMessageId: claimRow.id });
  });
  const options = {
    pool,
    tenantId,
    appId: 'ru.padlhub.test',
    environment: 'SANDBOX' as const,
    credentialRef: 'apns-test',
    cipher: { decrypt } as unknown as NotificationEndpointCipher,
    adapter: { send } as unknown as NotificationPushDeliveryPort,
    enabled: true,
  };
  return {
    options,
    query,
    queries,
    records,
    state,
    endpoint,
    send,
    decrypt,
    onClaim: (callback: () => void) => {
      onClaim = callback;
    },
  };
}

describe('ordinary APNs delivery', () => {
  it('works independently of scenarios, commits the fence before transport and sends generic content only', async () => {
    const h = harness();
    expect(await runApnsDeliveryBatch(h.options)).toBe(1);
    expect(h.state.delivery).toBe('SENT');
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'IOS',
        notification: {
          id: claimRow.intent_id,
          title: 'ПадлхАБ',
          preview: 'Новое уведомление',
          deepLink: '/notifications',
        },
      }),
    );
    expect(await runApnsDeliveryBatch(h.options)).toBe(0);
    expect(h.send).toHaveBeenCalledOnce();
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const cycle = source.slice(
      source.indexOf('const runApnsCycle'),
      source.indexOf('const runWebPushCycle'),
    );
    expect(cycle).toContain('runApnsDeliveryBatch');
    expect(cycle).not.toContain('NOTIFICATION_SCENARIOS_ENABLED');
    expect(source).toContain('void runApnsCycle();');
  });

  it('does no database work with APNs disabled', async () => {
    const h = harness();
    expect(await runApnsDeliveryBatch({ ...h.options, enabled: false })).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([
    { endpoint_user_id: 'another-user' },
    { endpoint_status: 'REVOKED' },
    { endpoint_status: 'INVALID' },
    { endpoint_status: 'SUSPENDED_POLICY' },
    { provider: 'FCM' },
    { platform: 'ANDROID' },
    { app_id: 'another.app' },
    { environment: 'PRODUCTION' },
    { credential_ref: 'other-key' },
    { provider_status: 'DISABLED' },
    { ios_push_enabled: false },
    { user_status: 'DISABLED' },
    { preference_enabled: false },
    { rule_active: false },
    { template_active: false },
    { provider_account_id: 'changed-provider' },
  ])('rechecks queued recipient/provider policy before dispatch: %j', async (changed) => {
    const h = harness();
    h.onClaim(() => Object.assign(h.endpoint, changed));
    await runApnsDeliveryBatch(h.options);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.delivery).toBe('SUPPRESSED');
    expect(h.state.attempts).toBe(0);
    expect(h.records).toContain('outbox');
  });

  it('suppresses an interruption when quiet hours begin after queueing', async () => {
    const h = harness();
    h.onClaim(() => Object.assign(h.endpoint, { quiet_from: '11:00', quiet_until: '13:00' }));
    await runApnsDeliveryBatch(h.options);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.values.includes('QUIET_HOURS'))).toBe(true);
    expect(h.queries.some((q) => q.text.includes('update notifications.inbox_items'))).toBe(false);
  });

  it('retains existing server-mandatory preference bypass', async () => {
    const h = harness({
      mandatory: true,
      preference_enabled: false,
      quiet_from: '11:00',
      quiet_until: '13:00',
    });
    await runApnsDeliveryBatch(h.options);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('never dispatches an expired claim and can reclaim it before any dispatch', async () => {
    const h = harness();
    h.onClaim(() => {
      h.state.expired = true;
    });
    await runApnsDeliveryBatch(h.options);
    expect(h.send).not.toHaveBeenCalled();
    h.onClaim(() => {});
    await runApnsDeliveryBatch(h.options);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.state.attempts).toBe(2);
  });

  it('a second worker cannot claim a live dispatched attempt', async () => {
    const h = harness();
    h.send.mockImplementationOnce(async () => {
      expect(await runApnsDeliveryBatch(h.options)).toBe(0);
      return { outcome: 'accepted', externalMessageId: claimRow.id };
    });
    await runApnsDeliveryBatch(h.options);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('terminalizes an expired dispatched claim after process loss without resending', async () => {
    const h = harness();
    h.send.mockImplementationOnce(() => {
      h.state.crashed = true;
      return Promise.reject(new Error('lost process'));
    });
    await expect(runApnsDeliveryBatch(h.options)).rejects.toThrow(
      'synthetic process connection lost',
    );
    expect(h.state.dispatched).toBe(true);
    h.state.crashed = false;
    h.state.expired = true;
    expect(await runApnsDeliveryBatch(h.options)).toBe(0);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.state.delivery).toBe('DEAD');
    expect(h.queries.some((q) => q.text.includes("last_error_code='APNS_OUTCOME_UNKNOWN'"))).toBe(
      true,
    );
    expect(h.records).toContain('attempt');
  });

  it('does not replay a provider timeout with an unknown outcome', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('transport response lost'));
    await runApnsDeliveryBatch(h.options);
    expect(h.state.delivery).toBe('DEAD');
    await runApnsDeliveryBatch(h.options);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('bounds definite retryable rejections to five attempts', async () => {
    const h = harness();
    h.send.mockResolvedValue({
      outcome: 'retryable_failure',
      errorCode: 'APNS_PROVIDER_RETRYABLE',
    });
    for (let attempt = 0; attempt < 6; attempt++) await runApnsDeliveryBatch(h.options);
    expect(h.send).toHaveBeenCalledTimes(5);
    expect(h.state.delivery).toBe('DEAD');
    expect(
      h.queries.some((q) =>
        q.text.includes("next_attempt_at=now() + ($4::integer * interval '1 millisecond')"),
      ),
    ).toBe(true);
  });

  it('defers circuit-open without consuming a provider attempt or retaining its dispatch marker', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({
      outcome: 'retryable_failure',
      errorCode: 'APNS_CIRCUIT_OPEN',
      retryAfterMs: 30000,
    });
    await runApnsDeliveryBatch(h.options);
    expect(h.state).toMatchObject({ delivery: 'PENDING', attempts: 0, dispatched: false });
    expect(h.records).not.toContain('attempt');
  });

  it.each(['unchanged', 'rotated', 'transferred'] as const)(
    'invalid token result invalidates only its exact endpoint snapshot: %s',
    async (change) => {
      const h = harness();
      h.send.mockImplementationOnce(() => {
        if (change === 'rotated') h.endpoint.address_ciphertext = Buffer.from('new token');
        if (change === 'transferred') h.endpoint.endpoint_user_id = 'new-user';
        return Promise.resolve({
          outcome: 'terminal_failure',
          errorCode: 'APNS_TOKEN_INVALID',
          invalidate: true,
        });
      });
      await runApnsDeliveryBatch(h.options);
      expect(h.state.delivery).toBe('DEAD');
      expect(h.endpoint.endpoint_status).toBe(change === 'unchanged' ? 'INVALID' : 'ACTIVE');
    },
  );

  it('unreadable encrypted addresses terminalize without a provider call', async () => {
    const h = harness();
    h.decrypt.mockImplementationOnce(() => {
      throw new Error('wrong key');
    });
    await runApnsDeliveryBatch(h.options);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.delivery).toBe('DEAD');
  });
});
