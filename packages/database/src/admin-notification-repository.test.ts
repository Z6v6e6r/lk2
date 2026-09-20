import { describe, expect, it, vi } from 'vitest';

import { createAdminNotificationRepository } from './admin-notification-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const userOneId = '11111111-1111-4111-8111-111111111111';
const userTwoId = '22222222-2222-4222-8222-222222222222';
const campaignId = '33333333-3333-4333-8333-333333333333';

const selector = {
  webPushAppId: 'padlhub-web',
  webPushEnvironment: 'SANDBOX' as const,
};

const campaignInput = {
  tenantId,
  actorUserId,
  normalizedPhones: ['79990000001'],
  normalizedUserIds: [] as readonly string[],
  title: 'Турнир сегодня',
  body: 'Начало в 19:00',
  requestedChannels: ['IN_APP', 'WEB_PUSH'] as const,
  requestHash: 'a'.repeat(64),
  idempotencyKey: 'admin-campaign-test-0001',
  correlationId: 'admin-campaign-correlation',
  webPushGloballyEnabled: true,
  ...selector,
};

function repositoryWithQuery(
  implementation: (
    text: string,
    values: readonly unknown[],
  ) => {
    rows: readonly Record<string, unknown>[];
    rowCount: number;
  },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(implementation(text, values));
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
  };
  return {
    query,
    release,
    repository: createAdminNotificationRepository(pool as never),
  };
}

function capabilitiesRow(overrides: Record<string, unknown> = {}) {
  return {
    in_app_enabled: true,
    web_push_enabled: true,
    ios_push_enabled: false,
    android_push_enabled: false,
    web_push_provider_configured: true,
    ...overrides,
  };
}

// A type alias (not an interface) keeps an implicit index signature, so fixtures satisfy the
// `Record<string, unknown>` rows of the query-shaped test double.
type RecipientRowFixture = {
  readonly user_id: string;
  readonly display_name: string;
  readonly phone_e164: string | null;
  readonly in_app_preference_enabled: boolean;
  readonly push_preference_enabled: boolean;
  readonly web_push_endpoint_count: number;
};

function recipientRowFixture(
  overrides: Partial<RecipientRowFixture> & { readonly user_id: string },
): RecipientRowFixture {
  return {
    display_name: 'Игрок',
    phone_e164: null,
    in_app_preference_enabled: true,
    push_preference_enabled: true,
    web_push_endpoint_count: 1,
    ...overrides,
  };
}

// The campaign projection walks identity, template, intent, delivery, inbox and endpoint writes. The
// phone selector (`with requested as`) and the user-id selector (`u.id = any($2::uuid[])`) are
// answered separately so a test can prove which selector actually ran.
function campaignProjectionHandler(input: {
  readonly phoneRows?: readonly RecipientRowFixture[];
  readonly userIdRows?: readonly RecipientRowFixture[];
  readonly endpointRows?: readonly { readonly id: string }[];
}) {
  let intentNumber = 0;
  let deliveryNumber = 0;
  const phoneRows = input.phoneRows ?? [];
  const userIdRows = input.userIdRows ?? [];
  const endpointRows = input.endpointRows ?? [{ id: '99999999-9999-4999-8999-999999999999' }];
  return (text: string) => {
    if (text.includes('from notifications.admin_campaign_commands')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('web_push_provider_configured')) {
      return { rows: [capabilitiesRow()], rowCount: 1 };
    }
    if (text.includes('u.id = any($2::uuid[])')) {
      return { rows: userIdRows, rowCount: userIdRows.length };
    }
    if (text.includes('join identity.users u')) {
      return { rows: phoneRows, rowCount: phoneRows.length };
    }
    if (text.includes('insert into notifications.templates')) {
      return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 };
    }
    if (text.includes('from notifications.templates')) return { rows: [], rowCount: 0 };
    if (text.includes('insert into notifications.admin_campaigns')) {
      return { rows: [{ id: campaignId }], rowCount: 1 };
    }
    if (text.includes('insert into notifications.intents')) {
      intentNumber += 1;
      return {
        rows: [{ id: `66666666-6666-4666-8666-66666666666${intentNumber}` }],
        rowCount: 1,
      };
    }
    if (text.includes('insert into notifications.deliveries')) {
      deliveryNumber += 1;
      return {
        rows: [{ id: `77777777-7777-4777-8777-77777777777${deliveryNumber}` }],
        rowCount: 1,
      };
    }
    if (text.includes('insert into notifications.inbox_items')) {
      return { rows: [{ id: '88888888-8888-4888-8888-888888888888' }], rowCount: 1 };
    }
    if (text.includes('from integration.notification_endpoints e')) {
      return { rows: endpointRows, rowCount: endpointRows.length };
    }
    if (
      text.includes('insert into notifications.admin_campaign_commands') ||
      text.includes('insert into audit.outbox_events') ||
      text.includes('insert into notifications.admin_campaign_recipients') ||
      text.includes('update notifications.admin_campaigns') ||
      text.includes('update notifications.admin_campaign_commands') ||
      text.includes('insert into audit.audit_log')
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
}

describe('admin notification repository', () => {
  it('reports disabled defaults when tenant runtime settings are absent', async () => {
    const { repository, release } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.getCapabilities({ tenantId, ...selector })).resolves.toEqual({
      inAppTenantEnabled: false,
      webPushTenantEnabled: false,
      webPushProviderConfigured: false,
      iosPushTenantEnabled: false,
      androidPushTenantEnabled: false,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('resolves only unambiguous active recipients and derives their available channels', async () => {
    const phones = ['79990000001', '79990000002', '79990000003'];
    const { repository } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      if (text.includes('join identity.users u')) {
        return {
          rows: [
            {
              user_id: userOneId,
              display_name: 'Анна',
              phone_e164: phones[0],
              in_app_preference_enabled: true,
              push_preference_enabled: true,
              web_push_endpoint_count: 1,
            },
            {
              user_id: userTwoId,
              display_name: 'Борис',
              phone_e164: phones[1],
              in_app_preference_enabled: false,
              push_preference_enabled: false,
              web_push_endpoint_count: 0,
            },
            {
              user_id: '44444444-4444-4444-8444-444444444444',
              display_name: 'Дубликат',
              phone_e164: phones[1],
              in_app_preference_enabled: true,
              push_preference_enabled: true,
              web_push_endpoint_count: 1,
            },
          ],
          rowCount: 3,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveRecipients({
        tenantId,
        normalizedPhones: phones,
        normalizedUserIds: [],
        webPushGloballyEnabled: true,
        ...selector,
      }),
    ).resolves.toEqual({
      matched: [
        {
          userId: userOneId,
          displayName: 'Анна',
          phoneMasked: '•••• 0001',
          availableChannels: ['IN_APP', 'WEB_PUSH'],
        },
      ],
      unresolvedPhones: ['•••• 0002', '•••• 0003'],
      unresolvedUserIds: [],
    });
  });

  it('asks the verified login phone first and only falls back to the provider mapping', async () => {
    const phones = ['79990000001'];
    const { repository, query } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      if (text.includes('join identity.users u')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });

    await repository.resolveRecipients({
      tenantId,
      normalizedPhones: phones,
      normalizedUserIds: [],
      webPushGloballyEnabled: true,
      ...selector,
    });

    const resolveSql = String(
      query.mock.calls.find(([text]) => String(text).includes('join identity.users u'))?.[0],
    );
    // The verified login phone always wins.
    expect(resolveSql).toContain('select login_phone.phone, login_phone.user_id from login_phone');
    // The provider viewer-phone mapping is the fallback that reaches OAuth-only accounts.
    expect(resolveSql).toContain('integration.external_entity_map');
    expect(resolveSql).toContain("entity_type = 'legacy_viewer_phone'");
    expect(resolveSql).toContain('link.internal_id as user_id');
    expect(resolveSql).toContain('where login_phone.phone = provider_link.phone');
  });

  it('does not query recipients for an empty phone list', async () => {
    const { repository, query } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveRecipients({
        tenantId,
        normalizedPhones: [],
        normalizedUserIds: [],
        webPushGloballyEnabled: false,
        ...selector,
      }),
    ).resolves.toEqual({ matched: [], unresolvedPhones: [], unresolvedUserIds: [] });
    expect(query.mock.calls.some(([text]) => String(text).includes('join identity.users u'))).toBe(
      false,
    );
  });

  it('rejects conflicting idempotency replays and restores accepted results', async () => {
    const conflict = repositoryWithQuery((text) => {
      if (text.includes('from notifications.admin_campaign_commands')) {
        return {
          rows: [{ request_hash: 'different', campaign_id: null, result_state: 'PENDING' }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    }).repository;
    await expect(conflict.createCampaign(campaignInput)).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });

    const replay = repositoryWithQuery((text) => {
      if (text.includes('from notifications.admin_campaign_commands')) {
        return {
          rows: [
            {
              request_hash: campaignInput.requestHash,
              campaign_id: campaignId,
              result_state: 'ACCEPTED',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('from notifications.admin_campaigns')) {
        return {
          rows: [
            {
              id: campaignId,
              matched_count: 2,
              unresolved_count: 1,
              in_app_created_count: 1,
              push_queued_count: 1,
              suppressed_count: 1,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    }).repository;
    await expect(replay.createCampaign(campaignInput)).resolves.toEqual({
      outcome: 'accepted',
      campaignId,
      matchedCount: 2,
      unresolvedCount: 1,
      inAppCreatedCount: 1,
      pushQueuedCount: 1,
      suppressedCount: 1,
      replayed: true,
    });
  });

  it('enforces tenant channel gates before resolving recipients', async () => {
    const inAppDisabled = repositoryWithQuery((text) => {
      if (text.includes('from notifications.admin_campaign_commands')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow({ in_app_enabled: false })], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    }).repository;
    await expect(
      inAppDisabled.createCampaign({ ...campaignInput, requestedChannels: ['IN_APP'] }),
    ).resolves.toEqual({ outcome: 'channel_unavailable', channel: 'IN_APP' });

    const webPushDisabled = repositoryWithQuery((text) => {
      if (text.includes('from notifications.admin_campaign_commands')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    }).repository;
    await expect(
      webPushDisabled.createCampaign({
        ...campaignInput,
        requestedChannels: ['WEB_PUSH'],
        webPushGloballyEnabled: false,
      }),
    ).resolves.toEqual({ outcome: 'channel_unavailable', channel: 'WEB_PUSH' });
  });

  it('returns recipients_not_found when no phone resolves unambiguously', async () => {
    const { repository } = repositoryWithQuery((text) => {
      if (text.includes('from notifications.admin_campaign_commands')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      if (text.includes('join identity.users u')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.createCampaign(campaignInput)).resolves.toEqual({
      outcome: 'recipients_not_found',
    });
  });

  it('lists Web Push subscribers with keyset pagination and masked phones', async () => {
    const subscriberRows = [
      {
        user_id: userOneId,
        display_name: 'Анна',
        phone_e164: '79990000001',
        endpoint_count: 2,
        last_confirmed_at: new Date('2026-09-17T12:00:00.000Z'),
        address_ciphertexts: [Buffer.from('endpoint-one'), Buffer.from('endpoint-two')],
        encryption_key_ids: ['v1', 'v1'],
      },
      {
        user_id: userTwoId,
        display_name: 'Борис',
        phone_e164: null,
        endpoint_count: 1,
        last_confirmed_at: null,
        address_ciphertexts: null,
        encryption_key_ids: null,
      },
    ];
    const { repository, query } = repositoryWithQuery((text) => {
      if (text.includes('from integration.notification_endpoints e')) {
        // The requested page size is one below the rows returned, so a next cursor must appear.
        return { rows: subscriberRows, rowCount: subscriberRows.length };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.listWebPushSubscribers({
        tenantId,
        webPushAppId: 'padlhub-web',
        webPushEnvironment: 'SANDBOX',
        limit: 1,
      }),
    ).resolves.toEqual({
      items: [
        {
          userId: userOneId,
          displayName: 'Анна',
          phoneMasked: '•••• 0001',
          endpointCount: 2,
          lastConfirmedAt: '2026-09-17T12:00:00.000Z',
          // The encrypted sample is carried so the admin route can name the push service.
          endpoints: [
            { ciphertext: Buffer.from('endpoint-one'), encryptionKeyId: 'v1' },
            { ciphertext: Buffer.from('endpoint-two'), encryptionKeyId: 'v1' },
          ],
        },
      ],
      nextCursor: userOneId,
    });

    // The query asks for the resolver's reachability predicate and only active accounts.
    const listSql = String(
      query.mock.calls.find(([text]) =>
        String(text).includes('from integration.notification_endpoints e'),
      )?.[0],
    );
    expect(listSql).toContain("e.channel = 'PUSH'");
    expect(listSql).toContain("a.provider = 'WEB_PUSH'");
    expect(listSql).toContain('a.environment = $3');
    expect(listSql).toContain("u.status = 'ACTIVE'");
    expect(listSql).toContain('u.id > $4::uuid');
  });

  it('omits the cursor on the last page of Web Push subscribers', async () => {
    const { repository } = repositoryWithQuery((text) => {
      if (text.includes('from integration.notification_endpoints e')) {
        return {
          rows: [
            {
              user_id: userOneId,
              display_name: 'Анна',
              phone_e164: null,
              endpoint_count: 1,
              last_confirmed_at: null,
              address_ciphertexts: null,
              encryption_key_ids: null,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.listWebPushSubscribers({
        tenantId,
        webPushAppId: 'padlhub-web',
        webPushEnvironment: 'SANDBOX',
        limit: 20,
        cursor: userTwoId,
      }),
    ).resolves.toEqual({
      items: [{ userId: userOneId, displayName: 'Анна', endpointCount: 1, endpoints: [] }],
    });
  });

  it('creates in-app and web-push projections while recording suppressed preferences', async () => {
    const { repository, query } = repositoryWithQuery(
      campaignProjectionHandler({
        phoneRows: [
          recipientRowFixture({
            user_id: userOneId,
            display_name: 'Анна',
            phone_e164: '79990000001',
          }),
          recipientRowFixture({
            user_id: userTwoId,
            display_name: 'Борис',
            phone_e164: '79990000002',
            in_app_preference_enabled: false,
            push_preference_enabled: false,
            web_push_endpoint_count: 0,
          }),
        ],
      }),
    );

    await expect(
      repository.createCampaign({
        ...campaignInput,
        normalizedPhones: ['79990000001', '79990000002'],
      }),
    ).resolves.toEqual({
      outcome: 'accepted',
      campaignId,
      matchedCount: 2,
      unresolvedCount: 0,
      inAppCreatedCount: 1,
      pushQueuedCount: 1,
      suppressedCount: 1,
      replayed: false,
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('insert into notifications.admin_campaign_recipients') &&
          (values as readonly unknown[]).includes('SUPPRESSED'),
      ),
    ).toBe(true);
  });

  it('resolves a user-id recipient that has no verified phone', async () => {
    const { repository, query } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      if (text.includes('u.id = any($2::uuid[])')) {
        return {
          rows: [
            recipientRowFixture({
              user_id: userOneId,
              display_name: 'Анна',
              phone_e164: null,
              web_push_endpoint_count: 2,
            }),
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveRecipients({
        tenantId,
        normalizedPhones: [],
        normalizedUserIds: [userOneId, userTwoId],
        webPushGloballyEnabled: true,
        ...selector,
      }),
    ).resolves.toEqual({
      matched: [
        {
          userId: userOneId,
          displayName: 'Анна',
          availableChannels: ['IN_APP', 'WEB_PUSH'],
        },
      ],
      unresolvedPhones: [],
      unresolvedUserIds: [userTwoId],
    });
    // A user-id preview never touches the phone selector query.
    expect(query.mock.calls.some(([text]) => String(text).includes('with requested as'))).toBe(
      false,
    );
  });

  it('lists a recipient addressed by phone and user id at the same time only once', async () => {
    const shared = recipientRowFixture({
      user_id: userOneId,
      display_name: 'Анна',
      phone_e164: '79990000001',
    });
    const { repository } = repositoryWithQuery((text) => {
      if (text.includes('web_push_provider_configured')) {
        return { rows: [capabilitiesRow()], rowCount: 1 };
      }
      if (text.includes('u.id = any($2::uuid[])')) return { rows: [shared], rowCount: 1 };
      if (text.includes('join identity.users u')) return { rows: [shared], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveRecipients({
        tenantId,
        normalizedPhones: ['79990000001'],
        normalizedUserIds: [userOneId],
        webPushGloballyEnabled: true,
        ...selector,
      }),
    ).resolves.toEqual({
      matched: [
        {
          userId: userOneId,
          displayName: 'Анна',
          phoneMasked: '•••• 0001',
          availableChannels: ['IN_APP', 'WEB_PUSH'],
        },
      ],
      unresolvedPhones: [],
      unresolvedUserIds: [],
    });
  });

  it('creates a campaign addressed only by user id and counts distinct selector values', async () => {
    const { repository, query } = repositoryWithQuery(
      campaignProjectionHandler({
        userIdRows: [
          recipientRowFixture({ user_id: userOneId, display_name: 'Анна' }),
          recipientRowFixture({
            user_id: userTwoId,
            display_name: 'Борис',
            push_preference_enabled: false,
            web_push_endpoint_count: 0,
            in_app_preference_enabled: false,
          }),
        ],
      }),
    );

    await expect(
      repository.createCampaign({
        ...campaignInput,
        normalizedPhones: [],
        normalizedUserIds: [userOneId, userTwoId, '44444444-4444-4444-8444-444444444444'],
      }),
    ).resolves.toEqual({
      outcome: 'accepted',
      campaignId,
      matchedCount: 2,
      unresolvedCount: 1,
      inAppCreatedCount: 1,
      pushQueuedCount: 1,
      suppressedCount: 1,
      replayed: false,
    });

    const campaignInsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into notifications.admin_campaigns'),
    );
    // input_count, matched_count and unresolved_count are stored per distinct selector value.
    expect(campaignInsert?.[1]?.slice(4)).toEqual([['IN_APP', 'WEB_PUSH'], 3, 2, 1, actorUserId]);
    expect(query.mock.calls.some(([text]) => String(text).includes('with requested as'))).toBe(
      false,
    );
  });

  it('writes one recipient, intent and dedupe key when both selectors name the same person', async () => {
    const { repository, query } = repositoryWithQuery(
      campaignProjectionHandler({
        phoneRows: [
          recipientRowFixture({
            user_id: userOneId,
            display_name: 'Анна',
            phone_e164: '79990000001',
          }),
        ],
        userIdRows: [recipientRowFixture({ user_id: userOneId, display_name: 'Анна' })],
      }),
    );

    await expect(
      repository.createCampaign({
        ...campaignInput,
        normalizedPhones: ['79990000001'],
        normalizedUserIds: [userOneId],
      }),
    ).resolves.toMatchObject({
      outcome: 'accepted',
      matchedCount: 1,
      // inputCount - matchedCount: the phone selector value did not add a second recipient.
      unresolvedCount: 1,
    });
    expect(
      query.mock.calls.filter(([text]) =>
        String(text).includes('insert into notifications.admin_campaign_recipients'),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([text]) =>
        String(text).includes('insert into notifications.intents'),
      ),
    ).toHaveLength(1);
  });

  it('keeps an ambiguous phone unresolved even when the same user is addressed by id', async () => {
    const { repository } = repositoryWithQuery(
      campaignProjectionHandler({
        phoneRows: [
          recipientRowFixture({
            user_id: userOneId,
            display_name: 'Анна',
            phone_e164: '79990000001',
          }),
          recipientRowFixture({
            user_id: '44444444-4444-4444-8444-444444444444',
            display_name: 'Дубликат',
            phone_e164: '79990000001',
          }),
        ],
        userIdRows: [recipientRowFixture({ user_id: userOneId, display_name: 'Анна' })],
      }),
    );

    await expect(
      repository.createCampaign({
        ...campaignInput,
        normalizedPhones: ['79990000001'],
        normalizedUserIds: [userOneId],
      }),
    ).resolves.toMatchObject({
      outcome: 'accepted',
      // The user id resolves Anna; the ambiguous phone still counts as one unresolved input.
      matchedCount: 1,
      unresolvedCount: 1,
    });
  });
});
