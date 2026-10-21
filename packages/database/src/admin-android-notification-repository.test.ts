import { describe, expect, it, vi } from 'vitest';
import { createAdminNotificationRepository } from './admin-notification-repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const androidPush = {
  globallyEnabled: true,
  appId: 'ru.padlhub.app',
  environment: 'SANDBOX' as const,
};
const input = {
  tenantId,
  actorUserId: userId,
  normalizedPhones: [],
  normalizedUserIds: [userId],
  title: 'Private inbox title',
  body: 'Private inbox body',
  deepLink: '/notifications',
  requestedChannels: ['ANDROID_PUSH', 'IN_APP'] as const,
  requestHash: 'a'.repeat(64),
  idempotencyKey: 'synthetic-android-campaign-command',
  correlationId: 'synthetic-correlation',
  webPushGloballyEnabled: true,
  webPushAppId: 'padlhub-web',
  webPushEnvironment: 'SANDBOX' as const,
  androidPush,
};

function fixture(
  overrides: {
    tenantEnabled?: boolean;
    providerConfigured?: boolean;
    preference?: boolean;
    endpoints?: number;
    replay?: boolean;
    conflict?: boolean;
    vanished?: boolean;
  } = {},
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes('from notifications.admin_campaign_commands') && overrides.replay)
      rows = [
        {
          request_hash: overrides.conflict ? 'b'.repeat(64) : input.requestHash,
          campaign_id: userId,
          result_state: 'ACCEPTED',
        },
      ];
    else if (text.includes('web_push_provider_configured'))
      rows = [
        {
          in_app_enabled: true,
          web_push_enabled: true,
          web_push_provider_configured: true,
          android_push_enabled: overrides.tenantEnabled ?? true,
          android_push_provider_configured: overrides.providerConfigured ?? true,
        },
      ];
    else if (text.includes('u.id = any($2::uuid[])'))
      rows = [
        {
          user_id: userId,
          display_name: 'Synthetic player',
          phone_e164: null,
          in_app_preference_enabled: true,
          push_preference_enabled: overrides.preference ?? true,
          web_push_endpoint_count: 2,
          android_push_endpoint_count: overrides.endpoints ?? 1,
        },
      ];
    else if (text.includes('select e.id'))
      rows = overrides.vanished ? [] : [{ id: tenantId, platform: 'ANDROID' }];
    else if (text.includes('insert into notifications.templates')) rows = [{ id: userId }];
    else if (text.includes('from notifications.templates')) rows = [];
    else if (text.includes('from notifications.admin_campaigns'))
      rows = [
        {
          id: userId,
          matched_count: 1,
          unresolved_count: 0,
          in_app_created_count: 1,
          push_queued_count: 1,
          suppressed_count: 0,
        },
      ];
    else if (text.includes('returning id')) rows = [{ id: userId }];
    return Promise.resolve({ rows, rowCount: rows.length || 1, values });
  });
  const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
  return { repository: createAdminNotificationRepository(pool as never), query };
}

describe('CUP Android campaign projection', () => {
  it('resolves Android only with its exact runtime selector and active endpoint', async () => {
    const { repository, query } = fixture();
    const resolved = await repository.resolveRecipients(input);
    expect(resolved.matched[0]?.availableChannels).toEqual(['IN_APP', 'WEB_PUSH', 'ANDROID_PUSH']);
    const select = query.mock.calls.find(([text]) => text.includes('u.id = any($2::uuid[])'))!;
    expect(select[0]).toContain("a.platform = 'ANDROID' and a.provider = 'FCM'");
    expect(select[1]).toEqual([
      tenantId,
      [userId],
      'padlhub-web',
      'SANDBOX',
      'ru.padlhub.app',
      'SANDBOX',
    ]);
    expect(JSON.stringify(resolved)).not.toMatch(/ciphertext|token|credential/u);
  });

  it.each(['global', 'tenant', 'provider'] as const)(
    'rejects the %s disabled gate before any campaign write',
    async (gate) => {
      const { repository, query } = fixture({
        tenantEnabled: gate !== 'tenant',
        providerConfigured: gate !== 'provider',
      });
      await expect(
        repository.createCampaign({
          ...input,
          androidPush: { ...androidPush, globallyEnabled: gate !== 'global' },
        }),
      ).resolves.toEqual({ outcome: 'channel_unavailable', channel: 'ANDROID_PUSH' });
      expect(query.mock.calls.some(([text]) => /insert into/u.test(text))).toBe(false);
    },
  );

  it('queues only requested Android endpoints, preserving one intent/inbox and opaque outbox events', async () => {
    const { repository, query } = fixture();
    const result = await repository.createCampaign(input);
    expect(result).toMatchObject({
      outcome: 'accepted',
      inAppCreatedCount: 1,
      pushQueuedCount: 1,
      replayed: false,
    });
    const endpoints = query.mock.calls.find(([text]) => text.includes('select e.id'))!;
    expect(endpoints[1]).toEqual([
      tenantId,
      userId,
      false,
      'padlhub-web',
      'SANDBOX',
      true,
      'ru.padlhub.app',
      'SANDBOX',
    ]);
    expect(endpoints[0]).toContain("a.platform = 'ANDROID' and a.provider = 'FCM'");
    const recipient = query.mock.calls.find(([text]) =>
      text.includes('insert into notifications.admin_campaign_recipients'),
    )!;
    expect(recipient[1]?.[5]).toEqual(['IN_APP', 'ANDROID_PUSH']);
    expect(recipient[1]?.[7]).toBe(1);
    const outbox = query.mock.calls.filter(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(JSON.stringify(outbox)).not.toContain(input.title);
    expect(JSON.stringify(outbox)).not.toContain(input.body);
  });

  it.each([{ preference: false }, { endpoints: 0 }])(
    'suppresses Android when consent or its endpoint is missing: %j',
    async (override) => {
      const { repository, query } = fixture(override);
      expect(await repository.createCampaign(input)).toMatchObject({
        pushQueuedCount: 0,
        inAppCreatedCount: 1,
      });
      expect(query.mock.calls.some(([text]) => text.includes('select e.id'))).toBe(false);
      const recipient = query.mock.calls.find(([text]) =>
        text.includes('insert into notifications.admin_campaign_recipients'),
      )!;
      expect(recipient[1]?.[5]).toEqual(['IN_APP']);
      expect(recipient[1]?.[6]).toEqual([
        override.preference === false
          ? 'PUSH_PREFERENCE_DISABLED'
          : 'ANDROID_PUSH_ENDPOINT_MISSING',
      ]);
    },
  );

  it('replays an accepted Android command even after gates turn off without adding deliveries', async () => {
    const { repository, query } = fixture({
      replay: true,
      tenantEnabled: false,
      providerConfigured: false,
    });
    expect(
      await repository.createCampaign({
        ...input,
        androidPush: { ...androidPush, globallyEnabled: false },
      }),
    ).toMatchObject({ outcome: 'accepted', replayed: true, pushQueuedCount: 1 });
    expect(query.mock.calls.some(([text]) => text.includes('insert into'))).toBe(false);
    expect(query.mock.calls.some(([text]) => text.includes('web_push_provider_configured'))).toBe(
      false,
    );
  });

  it('rejects a reused key with different Android command content', async () => {
    const { repository, query } = fixture({ replay: true, conflict: true });
    expect(await repository.createCampaign(input)).toEqual({ outcome: 'idempotency_conflict' });
    expect(query.mock.calls.some(([text]) => text.includes('insert into'))).toBe(false);
  });
  it('settles an intent if the Android endpoint disappears after recipient resolution', async () => {
    const { repository, query } = fixture({ vanished: true });
    expect(await repository.createCampaign(input)).toMatchObject({
      pushQueuedCount: 0,
      inAppCreatedCount: 1,
    });
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining('update notifications.intents set state'),
      [tenantId, userId, 'DELIVERED'],
    ]);
    const recipient = query.mock.calls.find(([text]) =>
      text.includes('insert into notifications.admin_campaign_recipients'),
    )!;
    expect(recipient[1]?.[5]).toEqual(['IN_APP']);
    expect(recipient[1]?.[6]).toEqual(['ANDROID_PUSH_ENDPOINT_MISSING']);
  });
});
