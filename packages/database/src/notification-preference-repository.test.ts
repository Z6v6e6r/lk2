import { describe, expect, it, vi } from 'vitest';

import { createNotificationPreferenceRepository } from './notification-preference-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

function transactionQuery(handler: (text: string, values?: readonly unknown[]) => unknown) {
  return vi.fn((text: string, values?: readonly unknown[]) => {
    if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return handler(text, values);
  });
}

describe('notification preference repository', () => {
  it('offers only the category/channel pairs an active tenant rule can deliver', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from notifications.trigger_rules')) {
        return Promise.resolve({
          rows: [
            { category: 'ADMIN_MESSAGE', channel: 'IN_APP' },
            { category: 'ADMIN_MESSAGE', channel: 'PUSH' },
            { category: 'BOOKING', channel: 'IN_APP' },
            { category: 'BOOKING', channel: 'PUSH' },
            { category: 'GAME', channel: 'EMAIL' },
            { category: 'MESSAGING', channel: 'IN_APP' },
          ],
          rowCount: 6,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationPreferenceRepository(poolWithQuery(query) as never);

    await expect(repository.listConfigurableChannels(tenantId)).resolves.toEqual([
      { category: 'ADMIN_MESSAGE', channel: 'IN_APP' },
      { category: 'ADMIN_MESSAGE', channel: 'PUSH' },
      { category: 'BOOKING', channel: 'IN_APP' },
      { category: 'BOOKING', channel: 'PUSH' },
      { category: 'MESSAGING', channel: 'IN_APP' },
    ]);
  });

  it('reads stored preferences and leaves an absent quiet window undefined', async () => {
    const query = transactionQuery(() =>
      Promise.resolve({
        rows: [
          {
            category: 'MESSAGING',
            channel: 'IN_APP',
            enabled: true,
            quiet_from: null,
            quiet_until: null,
            timezone: 'Europe/Moscow',
          },
          {
            category: 'MESSAGING',
            channel: 'PUSH',
            enabled: false,
            quiet_from: '23:00',
            quiet_until: '07:00',
            timezone: 'Europe/Moscow',
          },
        ],
        rowCount: 2,
      }),
    );
    const repository = createNotificationPreferenceRepository(poolWithQuery(query) as never);

    await expect(repository.listPreferences({ tenantId, userId })).resolves.toEqual([
      {
        category: 'MESSAGING',
        channel: 'IN_APP',
        enabled: true,
        timezone: 'Europe/Moscow',
      },
      {
        category: 'MESSAGING',
        channel: 'PUSH',
        enabled: false,
        quietFrom: '23:00',
        quietUntil: '07:00',
        timezone: 'Europe/Moscow',
      },
    ]);
  });

  it('writes one audited, identifier-only change and keeps a repeated write silent', async () => {
    const reads: unknown[][] = [
      [
        {
          category: 'MESSAGING',
          channel: 'PUSH',
          enabled: true,
          quiet_from: null,
          quiet_until: null,
          timezone: 'Europe/Moscow',
        },
      ],
      [
        {
          category: 'MESSAGING',
          channel: 'PUSH',
          enabled: false,
          quiet_from: '23:00',
          quiet_until: '07:00',
          timezone: 'Europe/Moscow',
        },
      ],
    ];
    const query = transactionQuery((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) {
        expect(values).toEqual([`${tenantId}:NOTIFICATION_PREFERENCES:${userId}`]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('from notifications.user_preferences')) {
        return Promise.resolve({ rows: reads.shift() ?? [], rowCount: 1 });
      }
      if (
        text.includes('insert into notifications.user_preferences') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('insert into audit.outbox_events')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationPreferenceRepository(poolWithQuery(query) as never);

    const result = await repository.replacePreferences({
      tenantId,
      userId,
      entries: [
        {
          category: 'MESSAGING',
          channel: 'PUSH',
          enabled: false,
          quietFrom: '23:00',
          quietUntil: '07:00',
          timezone: 'Europe/Moscow',
        },
      ],
      correlationId: 'preference-correlation-0001',
    });

    expect(result).toEqual([
      {
        category: 'MESSAGING',
        channel: 'PUSH',
        enabled: false,
        quietFrom: '23:00',
        quietUntil: '07:00',
        timezone: 'Europe/Moscow',
      },
    ]);
    const upsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into notifications.user_preferences'),
    );
    expect(upsert?.[1]).toEqual([
      tenantId,
      userId,
      'MESSAGING',
      'PUSH',
      false,
      '23:00',
      '07:00',
      'Europe/Moscow',
    ]);
    const audit = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(String(audit?.[1]?.[2])).toBe('preference-correlation-0001');
    expect(String(audit?.[1]?.[3])).toBe(
      JSON.stringify({ changed: [{ category: 'MESSAGING', channel: 'PUSH' }] }),
    );
    const event = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(String(event?.[1]?.[3])).toBe(
      JSON.stringify({
        recipientUserId: userId,
        changed: [{ category: 'MESSAGING', channel: 'PUSH' }],
      }),
    );
    // The event never carries the quiet window or any other preference value.
    expect(String(event?.[1]?.[3])).not.toContain('23:00');

    reads.push([
      {
        category: 'MESSAGING',
        channel: 'PUSH',
        enabled: false,
        quiet_from: '23:00',
        quiet_until: '07:00',
        timezone: 'Europe/Moscow',
      },
    ]);
    query.mockClear();
    await repository.replacePreferences({
      tenantId,
      userId,
      entries: [
        {
          category: 'MESSAGING',
          channel: 'PUSH',
          enabled: false,
          quietFrom: '23:00',
          quietUntil: '07:00',
          timezone: 'Europe/Moscow',
        },
      ],
      correlationId: 'preference-correlation-0002',
    });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into notifications.user_preferences'),
      ),
    ).toBe(false);
    expect(query.mock.calls.some(([text]) => String(text).includes('insert into audit.'))).toBe(
      false,
    );
  });

  it('normalizes a missing time zone to the documented default', async () => {
    const query = transactionQuery((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (text.includes('from notifications.user_preferences'))
        return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('insert into notifications.user_preferences')) {
        expect(values?.[7]).toBe('Europe/Moscow');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.')) return Promise.resolve({ rows: [], rowCount: 1 });
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationPreferenceRepository(poolWithQuery(query) as never);

    await repository.replacePreferences({
      tenantId,
      userId,
      entries: [{ category: 'GAME', channel: 'IN_APP', enabled: false }],
      correlationId: 'preference-correlation-0003',
    });

    const upsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into notifications.user_preferences'),
    );
    expect(upsert?.[1]?.slice(4)).toEqual([false, null, null, 'Europe/Moscow']);
  });
});
